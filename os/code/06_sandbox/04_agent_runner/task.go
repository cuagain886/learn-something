//go:build unix

// task.go — 任务状态机（阶段 ⑥）
//
// 核心设计：
//  1. 合法迁移写成【数据】（迁移表），非法迁移统一拒绝——这不是错误，是秩序
//  2. 终态无出边：迟到的取消、重复的完成，全部被挡下
//  3. 清理钩子挂在"进入终态"的迁移上 → 天然保证【恰好一次】
//  4. ⚠️ 钩子在锁外执行：钩子里要杀进程、删目录，不能占着锁
package main

import (
	"sync"
	"syscall"
	"time"
)

type State string

const (
	StatePending   State = "pending"
	StateRunning   State = "running"
	StateSucceeded State = "succeeded"
	StateFailed    State = "failed"
	StateTimeout   State = "timeout"
	StateCanceled  State = "canceled"
	StateOOMKilled State = "oom_killed"
)

// IsTerminal 终态判定：终态之后什么都不许改
func (s State) IsTerminal() bool {
	switch s {
	case StateSucceeded, StateFailed, StateTimeout, StateCanceled, StateOOMKilled:
		return true
	}
	return false
}

// transitions 是状态机的"宪法"——不在表里的迁移一律非法。
// 注意终态没有出边：这一条就消灭了"任务完成后又被改成运行中"这类事故。
var transitions = map[State][]State{
	StatePending: {StateRunning, StateCanceled},
	StateRunning: {StateSucceeded, StateFailed, StateTimeout, StateCanceled, StateOOMKilled},
}

// Limits 单任务的资源限额（阶段 ⑦）
type Limits struct {
	Timeout     time.Duration // wall-clock 超时
	GracePeriod time.Duration // SIGTERM 后的宽限期
	MaxOutput   int           // 输出字节上限
	CPUQuota    float64       // CPU 核数（cgroup）
	MemoryBytes int64         // 内存上限（cgroup）
	MaxPids     int           // 进程数上限（cgroup）← 防 fork bomb
}

func DefaultLimits() Limits {
	return Limits{
		Timeout:     10 * time.Second,
		GracePeriod: 2 * time.Second,
		MaxOutput:   256 << 10,
		CPUQuota:    0.5,
		MemoryBytes: 256 << 20,
		MaxPids:     64,
	}
}

// Task 一个执行任务的完整状态
type Task struct {
	ID       string
	TenantID string
	Script   string
	Limits   Limits

	mu         sync.Mutex
	state      State
	onTerminal []func(State)

	// 执行结果（进入终态后只读）
	ExitCode   int
	Signal     syscall.Signal
	Stdout     string
	Stderr     string
	Truncated  bool
	TotalBytes int64
	SubmitAt   time.Time
	StartAt    time.Time
	EndAt      time.Time

	// 运行时句柄（供清理与验尸使用）
	pgid       int
	workDir    string
	cgroupPath string
}

func NewTask(id, tenant, script string, limits Limits) *Task {
	return &Task{
		ID: id, TenantID: tenant, Script: script, Limits: limits,
		state: StatePending, ExitCode: -1, SubmitAt: time.Now(),
	}
}

func (t *Task) State() State {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.state
}

// OnTerminal 注册终态钩子。清理逻辑挂在这里 → 无论走哪条路径都恰好执行一次。
func (t *Task) OnTerminal(fn func(State)) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.onTerminal = append(t.onTerminal, fn)
}

// To 尝试状态迁移。返回 false = 非法迁移被拒绝（不是错误，是秩序）。
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
		return false // 迟到的取消、重复的完成，都在这里被静默挡下
	}

	t.state = next
	switch next {
	case StateRunning:
		t.StartAt = time.Now()
	default:
		if next.IsTerminal() {
			t.EndAt = time.Now()
		}
	}
	hooks := t.onTerminal
	isTerminal := next.IsTerminal()
	t.mu.Unlock() // ⚠️ 钩子在锁外跑：里面要杀进程、删目录，都是慢操作

	if isTerminal {
		for _, h := range hooks {
			h(next)
		}
	}
	return true
}

// Duration 任务执行时长（未开始则为 0）
func (t *Task) Duration() time.Duration {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.StartAt.IsZero() {
		return 0
	}
	if t.EndAt.IsZero() {
		return time.Since(t.StartAt)
	}
	return t.EndAt.Sub(t.StartAt)
}

// setResult 在锁保护下写入执行结果
func (t *Task) setResult(fn func(*Task)) {
	t.mu.Lock()
	defer t.mu.Unlock()
	fn(t)
}
