//go:build unix

// runner_test.go — 把三类并发攻击做成自动化测试
//
// 运行：go test -race ./06_sandbox/04_agent_runner -v
// ⚠️ 必须加 -race：状态机和幂等逻辑的正确性靠它保证
package main

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func testRunner(t *testing.T) *Runner {
	t.Helper()
	base := filepath.Join(os.TempDir(), "agent-runner-test")
	t.Cleanup(func() { os.RemoveAll(base) })
	return NewRunner(&LocalExecutor{BaseDir: base}, 8, 8, nil)
}

func waitFor(t *testing.T, task *Task, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if task.State().IsTerminal() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("任务 %s 在 %v 内未进入终态（当前 %s）", task.ID, timeout, task.State())
}

// 阶段 ①：四种结局必须能正确分类
func TestExecuteOutcomes(t *testing.T) {
	r := testRunner(t)
	cases := []struct {
		name   string
		script string
		want   State
		exit   int
	}{
		{"成功", `echo ok`, StateSucceeded, 0},
		{"业务失败", `exit 3`, StateFailed, 3},
		{"命令不存在", `no_such_cmd_xyz`, StateFailed, 127},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			task := NewTask("out-"+c.name, "test", c.script, DefaultLimits())
			if _, err := r.Submit(context.Background(), task, nil); err != nil {
				t.Fatalf("提交失败: %v", err)
			}
			waitFor(t, task, 10*time.Second)
			if task.State() != c.want {
				t.Errorf("state = %s, 期望 %s", task.State(), c.want)
			}
			if task.ExitCode != c.exit {
				t.Errorf("exit = %d, 期望 %d", task.ExitCode, c.exit)
			}
		})
	}
}

// 阶段 ②④：超时必须终止【整棵进程树】，且验尸无残留
func TestTimeoutKillsProcessTree(t *testing.T) {
	r := testRunner(t)
	limits := DefaultLimits()
	limits.Timeout = 1 * time.Second
	limits.GracePeriod = 500 * time.Millisecond

	// 三级进程树：sh → 后台 sleep；且 sh 忽略 TERM（无赖进程）
	task := NewTask("tree", "test",
		`trap '' TERM; sleep 30 & while :; do sleep 1; done`, limits)
	if _, err := r.Submit(context.Background(), task, nil); err != nil {
		t.Fatalf("提交失败: %v", err)
	}
	waitFor(t, task, 10*time.Second)

	if task.State() != StateTimeout {
		t.Errorf("state = %s, 期望 %s", task.State(), StateTimeout)
	}
	// 验尸：这才是真正的验收标准
	if issues := autopsy(task); len(issues) > 0 {
		t.Errorf("验尸发现残留: %v", issues)
	}
}

// 阶段 ③：只写 stderr 的任务不能死锁（管道 64KB 陷阱）
func TestNoPipeDeadlock(t *testing.T) {
	r := testRunner(t)
	limits := DefaultLimits()
	limits.Timeout = 8 * time.Second

	// 只往 stderr 写 200KB，远超管道 64KB 容量
	task := NewTask("stderr-flood", "test",
		`i=0; while [ $i -lt 4000 ]; do echo "err padding padding padding padding" >&2; i=$((i+1)); done`,
		limits)
	if _, err := r.Submit(context.Background(), task, nil); err != nil {
		t.Fatalf("提交失败: %v", err)
	}
	waitFor(t, task, 15*time.Second)

	if task.State() != StateSucceeded {
		t.Errorf("state = %s, 期望 succeeded（死锁会表现为 timeout）", task.State())
	}
}

// 阶段 ③：输出限额必须生效，且内存不随输出量增长
func TestOutputCapped(t *testing.T) {
	r := testRunner(t)
	limits := DefaultLimits()
	limits.Timeout = 8 * time.Second
	limits.MaxOutput = 16 << 10 // 16KB

	task := NewTask("flood", "test",
		`i=0; while [ $i -lt 20000 ]; do echo "0123456789012345678901234567890123456789"; i=$((i+1)); done`,
		limits)
	if _, err := r.Submit(context.Background(), task, nil); err != nil {
		t.Fatalf("提交失败: %v", err)
	}
	waitFor(t, task, 15*time.Second)

	if !task.Truncated {
		t.Error("truncated 应为 true")
	}
	if len(task.Stdout) > limits.MaxOutput+1024 {
		t.Errorf("留存输出 %d 字节，超过上限 %d", len(task.Stdout), limits.MaxOutput)
	}
	if task.TotalBytes <= int64(limits.MaxOutput) {
		t.Errorf("TotalBytes = %d，应记录【真实产出量】用于审计", task.TotalBytes)
	}
}

// 阶段 ⑥ 攻击 A：并发重复提交，只能执行一次
func TestIdempotentSubmit(t *testing.T) {
	r := testRunner(t)
	var accepted, duplicated int
	var mu sync.Mutex
	var wg sync.WaitGroup

	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			task := NewTask("same-id", "test", `echo once`, DefaultLimits())
			_, err := r.Submit(context.Background(), task, nil)
			mu.Lock()
			defer mu.Unlock()
			switch err {
			case nil:
				accepted++
			case ErrDuplicate:
				duplicated++
			}
		}()
	}
	wg.Wait()

	if accepted != 1 {
		t.Errorf("真正执行 %d 次，期望恰好 1 次（check-then-act 竞态？）", accepted)
	}
	if duplicated != 99 {
		t.Errorf("幂等返回 %d 次，期望 99 次", duplicated)
	}
}

// 阶段 ⑥ 攻击 B/C：迟到的取消与终态篡改必须被拒绝
func TestStateMachineRejectsIllegalTransitions(t *testing.T) {
	r := testRunner(t)
	task := NewTask("terminal", "test", `echo done`, DefaultLimits())
	if _, err := r.Submit(context.Background(), task, nil); err != nil {
		t.Fatalf("提交失败: %v", err)
	}
	waitFor(t, task, 10*time.Second)

	final := task.State()
	// 迟到的取消
	if err := r.Cancel("terminal"); err == nil {
		t.Error("终态后的取消应被拒绝")
	}
	// 终态篡改
	if task.To(StateFailed) {
		t.Error("终态不应能改成 failed")
	}
	if task.To(StateRunning) {
		t.Error("终态不应能改回 running")
	}
	if task.State() != final {
		t.Errorf("终态被改动: %s → %s", final, task.State())
	}
}

// 阶段 ⑥：清理钩子必须【恰好执行一次】
func TestCleanupExactlyOnce(t *testing.T) {
	var count int
	var mu sync.Mutex
	task := NewTask("hook", "test", `echo x`, DefaultLimits())
	task.OnTerminal(func(State) { mu.Lock(); count++; mu.Unlock() })

	// 并发尝试多次迁移，只有第一个合法迁移会触发钩子
	var wg sync.WaitGroup
	task.To(StateRunning)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			if n%2 == 0 {
				task.To(StateSucceeded)
			} else {
				task.To(StateCanceled)
			}
		}(i)
	}
	wg.Wait()

	mu.Lock()
	defer mu.Unlock()
	if count != 1 {
		t.Errorf("终态钩子执行 %d 次，期望恰好 1 次", count)
	}
}

// 阶段 ⑤：并发额度不能泄漏（泄漏会让 Runner 逐渐假死）
func TestConcurrencySlotsReleased(t *testing.T) {
	r := testRunner(t)
	limits := DefaultLimits()
	limits.Timeout = 3 * time.Second

	for round := 0; round < 3; round++ {
		var wg sync.WaitGroup
		for i := 0; i < 8; i++ {
			wg.Add(1)
			go func(n int) {
				defer wg.Done()
				task := NewTask(
					filepath.Base(t.Name())+string(rune('a'+round))+string(rune('0'+n)),
					"test", `echo x`, limits)
				r.Submit(context.Background(), task, nil)
			}(i)
		}
		wg.Wait()
		if !r.WaitAll(20 * time.Second) {
			t.Fatalf("第 %d 轮后仍有任务未结束——并发名额可能泄漏", round)
		}
	}
	if got := r.Metrics().Running.Load(); got != 0 {
		t.Errorf("running = %d，期望 0", got)
	}
}
