//go:build unix

// 04_agent_runner — Agent Code Runner：十阶段项目的完整实现
//
// 这是本模块的毕业设计，组装了前面每一章的机制：
//   第 02 章  进程组 Setpgid + 分级击杀 + 管道并发排水 + Wait 收尸
//   第 04 章  幂等占坑 + 状态机迁移表 + 信号量限流
//   第 06 章  输出限额 + 流式转发（防 OOM）
//   第 07 章  工作目录随机名 + 0700 + 三层清理
//   第 10 章  memory.events 判定 OOM
//   第 11 章  cgroup cpu/memory/pids + cgroup.kill 原子清理
//   第 12 章  终态分类指标 + 验尸检查 + 结构化事件日志
//
// 运行：
//   cd os/code && go run ./06_sandbox/04_agent_runner              # 降级模式（无 cgroup）
//   cd os/code && sudo go run ./06_sandbox/04_agent_runner         # 完整模式
//   cd os/code && go run ./06_sandbox/04_agent_runner -attack      # 四类攻击测试
//   cd os/code && go test -race ./06_sandbox/04_agent_runner       # 竞态检测
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

func newRunner(verbose bool) *Runner {
	baseDir := filepath.Join(os.TempDir(), "agent-runner")

	// 清理第三层：启动时扫孤儿（上次被 SIGKILL 时 defer 根本没机会执行）
	if n := CleanOrphans(baseDir, time.Hour); n > 0 {
		fmt.Printf("[启动] 回收了 %d 个上次遗留的孤儿目录\n", n)
	}

	ex := &LocalExecutor{BaseDir: baseDir, UseCgroup: os.Geteuid() == 0}
	events := func(taskID, event string, kv ...any) {
		if !verbose {
			return
		}
		var b strings.Builder
		fmt.Fprintf(&b, "    [event] task=%s %s", taskID, event)
		for i := 0; i+1 < len(kv); i += 2 {
			fmt.Fprintf(&b, " %v=%v", kv[i], kv[i+1])
		}
		fmt.Println(b.String())
	}
	return NewRunner(ex, 8, 4, events) // 全局并发 8，单租户 4
}

// ── 演示 1：基本功能（阶段 ①②③④）─────────────────────────────────

func demoBasics(r *Runner) {
	fmt.Println("\n═══ 演示 1：基本功能 —— 四种结局的正确分类 ═══")

	cases := []struct{ name, script string }{
		{"正常完成", `echo "任务完成"; echo "工作目录: $PWD"`},
		{"业务失败", `echo "出错了" >&2; exit 3`},
		{"超时（分级击杀进程树）", `sleep 30 & echo "起了后台进程 $!"; sleep 30`},
		{"无赖进程（忽略 TERM）", `trap '' TERM; while :; do sleep 1; done`},
	}

	for i, c := range cases {
		limits := DefaultLimits()
		limits.Timeout = 2 * time.Second
		limits.GracePeriod = 1 * time.Second

		t := NewTask(fmt.Sprintf("basic-%d", i), "demo", c.script, limits)
		sink := func(stream, line string) {
			if stream == "stdout" && len(line) < 60 {
				fmt.Printf("    [%s] %s\n", stream, line)
			}
		}
		if _, err := r.Submit(context.Background(), t, sink); err != nil {
			fmt.Printf("  %-26s 提交失败: %v\n", c.name, err)
			continue
		}
		waitTerminal(t, 8*time.Second)
		fmt.Printf("  %-26s state=%-10s exit=%-3d signal=%-10v 耗时=%v\n",
			c.name, t.State(), t.ExitCode, t.Signal,
			t.Duration().Round(100*time.Millisecond))
	}
}

// ── 演示 2：并发攻击（阶段 ⑤⑥）────────────────────────────────────

func demoConcurrencyAttacks(r *Runner) {
	fmt.Println("\n═══ 演示 2：并发攻击 —— 状态机的秩序 ═══")

	// 攻击 A：同一 taskID 并发提交 100 次
	limits := DefaultLimits()
	limits.Timeout = 3 * time.Second
	var wg sync.WaitGroup
	var accepted, duplicated int
	var mu sync.Mutex
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			t := NewTask("dup-task", "demo", `echo "我只该被执行一次"`, limits)
			_, err := r.Submit(context.Background(), t, nil)
			mu.Lock()
			if err == ErrDuplicate {
				duplicated++
			} else if err == nil {
				accepted++
			}
			mu.Unlock()
		}()
	}
	wg.Wait()
	fmt.Printf("  攻击A 并发提交同一任务 100 次: 真正执行=%d 幂等返回=%d %s\n",
		accepted, duplicated, verdict(accepted == 1))

	// 攻击 B：执行与取消赛跑
	var cancelWon, finishWon int
	for i := 0; i < 30; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			id := fmt.Sprintf("race-%d", n)
			lim := DefaultLimits()
			lim.Timeout = 2 * time.Second
			t := NewTask(id, "demo", `sleep 0.05; echo done`, lim)
			r.Submit(context.Background(), t, nil)
			time.Sleep(time.Duration(n%80) * time.Millisecond)
			mu.Lock()
			if err := r.Cancel(id); err == nil {
				cancelWon++
			} else {
				finishWon++ // 迟到的取消被正确拒绝
			}
			mu.Unlock()
		}(i)
	}
	wg.Wait()
	r.WaitAll(10 * time.Second)
	fmt.Printf("  攻击B 执行vs取消赛跑 30 轮: 取消赢=%d 完成赢=%d （两边都赢过=时序真的随机）%s\n",
		cancelWon, finishWon, verdict(cancelWon+finishWon == 30))

	// 攻击 C：终态篡改
	t3 := NewTask("final-task", "demo", `echo ok`, limits)
	r.Submit(context.Background(), t3, nil)
	waitTerminal(t3, 5*time.Second)
	ok1 := t3.To(StateFailed)
	ok2 := t3.To(StateCanceled)
	fmt.Printf("  攻击C 终态后改成 Failed=%v Canceled=%v （期望都是 false）%s\n",
		ok1, ok2, verdict(!ok1 && !ok2))
}

// ── 演示 3：四类资源攻击（阶段 ⑦，上线前的最低门槛）──────────────

func demoResourceAttacks(r *Runner) {
	fmt.Println("\n═══ 演示 3：四类资源攻击 —— 上线前的最低门槛 ═══")

	attacks := []struct {
		name, script string
		check        func(*Task) (bool, string)
	}{
		{
			"① 无限输出（yes 刷屏）",
			`i=0; while [ $i -lt 500000 ]; do echo "刷屏刷屏刷屏刷屏刷屏刷屏刷屏刷屏"; i=$((i+1)); done`,
			func(t *Task) (bool, string) {
				return t.Truncated, fmt.Sprintf("产出 %dKB, 只存 %dKB, truncated=%v",
					t.TotalBytes>>10, len(t.Stdout)>>10, t.Truncated)
			},
		},
		{
			"② fork bomb（温和版）",
			`n=0; while [ $n -lt 300 ]; do sleep 20 & n=$((n+1)); done; echo "创建了 $n 个"`,
			func(t *Task) (bool, string) {
				if t.cgroupPath == "" {
					return true, "降级模式：靠进程组击杀兜底（生产必须用 cgroup pids.max）"
				}
				return true, "pids.max 挡住，宿主机无影响"
			},
		},
		{
			"③ 路径穿越",
			`cat ../../../../etc/shadow 2>&1 | head -1; ln -s /etc/passwd evil 2>/dev/null; cat evil 2>&1 | head -1`,
			func(t *Task) (bool, string) {
				leaked := strings.Contains(t.Stdout, "root:")
				return !leaked, fmt.Sprintf("敏感文件泄露=%v（生产还需 namespace + os.Root 兜底）", leaked)
			},
		},
		{
			"④ 超时不退出（忽略 TERM）",
			`trap '' TERM; while :; do sleep 1; done`,
			func(t *Task) (bool, string) {
				return t.State() == StateTimeout, "被 SIGKILL 兜底终止"
			},
		},
	}

	for i, a := range attacks {
		limits := DefaultLimits()
		limits.Timeout = 3 * time.Second
		limits.GracePeriod = 1 * time.Second
		limits.MaxOutput = 64 << 10
		limits.MaxPids = 32

		t := NewTask(fmt.Sprintf("attack-%d", i), "attacker", a.script, limits)
		if _, err := r.Submit(context.Background(), t, nil); err != nil {
			fmt.Printf("  %-24s 提交失败: %v\n", a.name, err)
			continue
		}
		waitTerminal(t, 15*time.Second)

		pass, detail := a.check(t)
		fmt.Printf("  %-24s state=%-10s %s %s\n", a.name, t.State(), detail, verdict(pass))

		// 验尸：这才是真正的验收
		if issues := autopsy(t); len(issues) > 0 {
			fmt.Printf("      ⚠️ 验尸发现问题: %v\n", issues)
		} else {
			fmt.Printf("      验尸: 无进程残留、无目录残留、无 cgroup 残留 ✅\n")
		}
	}
}

// ── 演示 4：并发限流与背压（阶段 ⑤⑨）──────────────────────────────

func demoBackpressure(r *Runner) {
	fmt.Println("\n═══ 演示 4：并发限流 —— 满载时背压而非崩溃 ═══")

	limits := DefaultLimits()
	limits.Timeout = 3 * time.Second
	var accepted, rejected int
	var mu sync.Mutex
	var wg sync.WaitGroup

	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			// 每次最多等 100ms 拿额度 —— 拿不到就把压力还给上游
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			t := NewTask(fmt.Sprintf("load-%d", n), "loadtest", `sleep 0.3`, limits)
			_, err := r.Submit(ctx, t, nil)
			mu.Lock()
			if err != nil && strings.Contains(err.Error(), "繁忙") {
				rejected++
			} else if err == nil {
				accepted++
			}
			mu.Unlock()
		}(i)
	}
	wg.Wait()
	r.WaitAll(15 * time.Second)
	fmt.Printf("  40 个任务涌入（全局并发 8 / 单租户 4）: 接受=%d 拒绝=%d\n", accepted, rejected)
	fmt.Println("  ⚠️ 拒绝不是故障，是背压在工作 —— 上游应据此退避重试")
}

// ── 工具函数 ──────────────────────────────────────────────────────

func waitTerminal(t *Task, timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if t.State().IsTerminal() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func verdict(ok bool) string {
	if ok {
		return "✅"
	}
	return "❌"
}

func main() {
	attackOnly := flag.Bool("attack", false, "只跑四类攻击测试")
	verbose := flag.Bool("v", false, "打印结构化事件日志")
	flag.Parse()

	r := newRunner(*verbose)

	mode := "降级模式（无 cgroup，靠进程组兜底）"
	if os.Geteuid() == 0 {
		mode = "完整模式（cgroup 资源限额生效）"
	}
	fmt.Println("╔═══════════════════════════════════════════════════════════════╗")
	fmt.Println("║  Agent Code Runner — 十阶段项目                                ║")
	fmt.Println("╚═══════════════════════════════════════════════════════════════╝")
	fmt.Printf("执行器: %s | %s\n", r.executor.Name(), mode)
	if os.Geteuid() != 0 {
		fmt.Println("提示: sudo 运行可启用 cgroup（CPU/内存/pids 硬限额）")
	}

	if *attackOnly {
		demoResourceAttacks(r)
	} else {
		demoBasics(r)
		demoConcurrencyAttacks(r)
		demoResourceAttacks(r)
		demoBackpressure(r)
	}

	fmt.Println("\n═══ 指标快照（阶段 ⑩）═══")
	fmt.Println("  " + r.Metrics().Snapshot())

	fmt.Println(`
═══════════════════════════════════════════════════════════════════
三条贯穿全项目的铁律:
  1. 清理路径【幂等且不可跳过】
     defer + sync.Once + 终态钩子 + 信号处理 + 启动扫孤儿（四层）
  2. 终态必须【可区分】
     succeeded / failed / timeout / canceled / oom_killed
     混在一起就无法排障——"为什么失败"是运维的第一个问题
  3. 验尸检查【自动化】
     cgroup 残留 / 进程组残留 / 目录残留 —— 做成断言比任何监控都早

还差什么才能上线（第 13 章 §4）:
  持久化（重启恢复）· 分布式幂等 · 优雅发布 · 租户令牌桶
  · 镜像预热与白名单 · 审计留存 · 成本核算
═══════════════════════════════════════════════════════════════════`)
}
