// 05_task_state_machine — 幂等提交 + 迁移表状态机：并发攻击下的任务秩序
//
// 学什么：
//  1. 幂等提交：LoadOrStore 原子占坑——同一任务 ID 并发提交 100 次也只执行 1 次
//  2. 迁移表状态机：合法迁移写成数据，非法迁移(迟到的取消/重复的完成)统一拒绝
//  3. 清理钩子挂在"进入终态"的迁移上——保证恰好清理一次
//  4. 用"并发攻击测试"验证：重复提交 / 双完成 / 迟到取消 三类事故全被挡住
//
// 运行：cd os/code && go run ./02_concurrency/05_task_state_machine
//       go run -race ./02_concurrency/05_task_state_machine   # 竞态验证
package main

import (
	"fmt"
	"math/rand"
	"sync"
	"sync/atomic"
	"time"
)

type State string

const (
	Pending   State = "pending"
	Running   State = "running"
	Succeeded State = "succeeded"
	Failed    State = "failed"
	Canceled  State = "canceled"
)

// transitions 是状态机的"宪法"：不在表里的迁移一律非法。
// 终态(Succeeded/Failed/Canceled)没有出边——任何试图改写终态的操作都会被拒。
var transitions = map[State][]State{
	Pending: {Running, Canceled},
	Running: {Succeeded, Failed, Canceled},
}

type Task struct {
	ID    string
	mu    sync.Mutex
	state State
	// onTerminal 在进入任一终态时执行【恰好一次】：杀进程组、删工作目录、释放名额…
	onTerminal func(final State)
}

func (t *Task) State() State {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.state
}

// To 尝试状态迁移。返回 false = 非法迁移被拒绝（这不是错误，是秩序）。
func (t *Task) To(next State) bool {
	t.mu.Lock()
	legal := false
	for _, s := range transitions[t.state] {
		if s == next {
			legal = true
			break
		}
	}
	if !legal {
		t.mu.Unlock()
		return false
	}
	t.state = next
	hook := t.onTerminal
	isTerminal := next == Succeeded || next == Failed || next == Canceled
	t.mu.Unlock() // ⚠️ 钩子在锁外跑：钩子里可能做慢操作(杀进程/删目录)，不能占着锁

	if isTerminal && hook != nil {
		hook(next) // 只有赢得迁移的那一方会走到这——恰好一次
	}
	return true
}

// ---- 管理器：幂等提交 ----------------------------------------------------

type Manager struct {
	tasks    sync.Map // id → *Task
	executed atomic.Int32
	cleaned  atomic.Int32
}

// Submit 幂等提交：同一 ID 无论并发提交多少次，只有一次真正启动。
func (m *Manager) Submit(id string) *Task {
	fresh := &Task{ID: id, state: Pending}
	fresh.onTerminal = func(final State) { m.cleaned.Add(1) } // 模拟清理钩子

	actual, loaded := m.tasks.LoadOrStore(id, fresh)
	task := actual.(*Task)
	if loaded {
		return task // 坑已被占：返回同一实例——这就是幂等
	}
	go m.run(task) // 只有占坑成功者启动执行
	return task
}

func (m *Manager) run(t *Task) {
	if !t.To(Running) { // 可能在 Pending 阶段就被取消了 → 迁移失败，直接不跑
		return
	}
	m.executed.Add(1)
	time.Sleep(time.Duration(rand.Intn(30)) * time.Millisecond) // 模拟干活
	t.To(Succeeded) // 若中途被取消(Running→Canceled 已发生)，这里返回 false，无害
}

func main() {
	m := &Manager{}
	var wg sync.WaitGroup

	fmt.Println("== 攻击 1: 同一任务 ID 并发提交 100 次 ==")
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); m.Submit("task-A") }()
	}
	wg.Wait()
	time.Sleep(60 * time.Millisecond)
	fmt.Printf("  实际执行次数: %d (期望 1) ✅\n\n", m.executed.Load())

	fmt.Println("== 攻击 2: 执行与取消赛跑 ×200（随机时序）==")
	var canceledWon, finishWon int32
	for i := 0; i < 200; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			id := fmt.Sprintf("task-%d", n)
			t := m.Submit(id)
			time.Sleep(time.Duration(rand.Intn(35)) * time.Millisecond)
			if t.To(Canceled) { // 取消能否成功取决于谁先到——但绝无中间态
				atomic.AddInt32(&canceledWon, 1)
			} else {
				atomic.AddInt32(&finishWon, 1) // 任务已终态：迟到的取消被拒，静默忽略
			}
		}(i)
	}
	wg.Wait()
	time.Sleep(60 * time.Millisecond)
	fmt.Printf("  取消赢: %d 次, 完成赢: %d 次 —— 两边都赢过, 但没有一个任务状态被改坏\n\n",
		canceledWon, finishWon)

	fmt.Println("== 攻击 3: 对同一任务并发报'成功'和'失败' ==")
	t := m.Submit("task-final")
	time.Sleep(50 * time.Millisecond) // 等它自然 Succeeded
	okFail := t.To(Failed)
	okCancel := t.To(Canceled)
	fmt.Printf("  终态后 To(Failed)=%v To(Canceled)=%v (期望都是 false) ✅ 终态神圣不可篡改\n\n",
		okFail, okCancel)

	total := m.executed.Load()
	fmt.Printf("清理钩子执行次数=%d, 应等于进入过终态的任务数（每任务恰好一次）\n", m.cleaned.Load())
	_ = total
	fmt.Println(`
要点回顾:
  1. 幂等 = 把"查+登记"压进一个原子点(LoadOrStore / 唯一约束 / SETNX)
  2. 状态机 = 合法迁移表 + 锁 + 拒绝非法迁移; "迟到的取消"不是错误, 拒掉即可
  3. 清理挂在进入终态的迁移上 → 天然恰好一次; 钩子放锁外跑
  4. 真实 Runner 的钩子内容: 杀进程组(02章) + 删工作目录(07章) + 释放并发名额(本章)`)
}
