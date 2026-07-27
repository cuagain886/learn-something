//go:build unix

// runner.go — Runner：幂等提交、并发限流、指标采集（阶段 ⑤⑥⑨⑩）
//
// 分层原则：
//   Runner 层  = 状态机 + 幂等 + 限流 + 指标 + 清理编排（只写一遍）
//   Executor 层 = 怎么跑（本地/容器/远程，可插拔）
// 这个分层是整个项目最关键的设计决策。
package main

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

var (
	ErrBusy       = errors.New("runner 繁忙：并发额度已满")
	ErrDuplicate  = errors.New("任务已存在（幂等返回）")
	ErrNoSuchTask = errors.New("任务不存在")
)

// Metrics 最小可观测集（阶段 ⑩，第 12 章 §7）
type Metrics struct {
	Running       atomic.Int64
	Submitted     atomic.Int64
	Rejected      atomic.Int64
	Duplicated    atomic.Int64
	Truncated     atomic.Int64
	AutopsyIssues atomic.Int64

	mu        sync.Mutex
	byState   map[State]int  // ⚠️ 按终态分类计数——排障的起点
	durations []time.Duration
}

func newMetrics() *Metrics { return &Metrics{byState: map[State]int{}} }

func (m *Metrics) recordTerminal(s State, d time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.byState[s]++
	m.durations = append(m.durations, d)
}

func (m *Metrics) Snapshot() string {
	m.mu.Lock()
	defer m.mu.Unlock()

	states := make([]string, 0, len(m.byState))
	for s, n := range m.byState {
		states = append(states, fmt.Sprintf("%s=%d", s, n))
	}
	sort.Strings(states)

	var p50, p95 time.Duration
	if len(m.durations) > 0 {
		ds := append([]time.Duration(nil), m.durations...)
		sort.Slice(ds, func(i, j int) bool { return ds[i] < ds[j] })
		p50 = ds[len(ds)*50/100]
		p95 = ds[min(len(ds)*95/100, len(ds)-1)]
	}

	return fmt.Sprintf(
		"submitted=%d rejected=%d duplicated=%d running=%d truncated=%d autopsy_issues=%d\n"+
			"    终态分布: %v\n    时长: P50=%v P95=%v",
		m.Submitted.Load(), m.Rejected.Load(), m.Duplicated.Load(),
		m.Running.Load(), m.Truncated.Load(), m.AutopsyIssues.Load(),
		states, p50.Round(time.Millisecond), p95.Round(time.Millisecond))
}

// Tenant 租户及其配额（阶段 ⑨）
type Tenant struct {
	ID  string
	sem chan struct{} // 租户级并发额度
}

type Runner struct {
	executor    Executor
	sem         chan struct{} // 全局并发额度
	tasks       sync.Map      // taskID → *Task
	tenants     sync.Map      // tenantID → *Tenant
	perTenantMax int
	metrics     *Metrics
	events      func(taskID, event string, kv ...any) // 结构化日志
}

func NewRunner(ex Executor, maxConcurrent, perTenantMax int, events func(string, string, ...any)) *Runner {
	if events == nil {
		events = func(string, string, ...any) {}
	}
	return &Runner{
		executor:     ex,
		sem:          make(chan struct{}, maxConcurrent),
		perTenantMax: perTenantMax,
		metrics:      newMetrics(),
		events:       events,
	}
}

func (r *Runner) tenantSem(id string) chan struct{} {
	v, _ := r.tenants.LoadOrStore(id, &Tenant{
		ID: id, sem: make(chan struct{}, r.perTenantMax),
	})
	return v.(*Tenant).sem
}

// Submit 提交任务。⚠️ 三个保证：
//  1. 幂等：同一 taskID 并发提交任意多次，只执行一次
//  2. 限流：全局 + 租户两级并发额度，满了返回 ErrBusy（背压而非崩溃）
//  3. 清理：无论走哪条路径，资源都会被回收
func (r *Runner) Submit(ctx context.Context, t *Task, sink OutputSink) (*Task, error) {
	// ── 阶段 ⑥：幂等占坑（第 04 章 §4.1）─────────────────────────────
	// LoadOrStore 把"查 + 登记"压成一个原子点 —— 竞态无处藏身
	actual, loaded := r.tasks.LoadOrStore(t.ID, t)
	if loaded {
		r.metrics.Duplicated.Add(1)
		r.events(t.ID, "duplicate_submit")
		return actual.(*Task), ErrDuplicate // 幂等返回同一实例
	}
	r.metrics.Submitted.Add(1)
	r.events(t.ID, "submitted", "tenant", t.TenantID)

	// ── 清理钩子挂在终态迁移上 → 天然保证恰好一次（第 04 章 §4.2）────
	t.OnTerminal(func(final State) {
		if problems := cleanupTask(t); len(problems) > 0 {
			r.events(t.ID, "cleanup_warning", "problems", problems)
		}
		if issues := autopsy(t); len(issues) > 0 {
			r.metrics.AutopsyIssues.Add(int64(len(issues)))
			r.events(t.ID, "autopsy_failed", "issues", issues) // ⚠️ 这里应该告警
		}
		if t.Truncated {
			r.metrics.Truncated.Add(1)
		}
		r.metrics.recordTerminal(final, t.Duration())
		r.events(t.ID, "terminated", "state", final,
			"exit", t.ExitCode, "signal", t.Signal,
			"duration_ms", t.Duration().Milliseconds(),
			"output_bytes", t.TotalBytes, "truncated", t.Truncated)
	})

	// ── 阶段 ⑤⑨：两级并发限流（第 04 章 §4.3）───────────────────────
	tsem := r.tenantSem(t.TenantID)
	select {
	case tsem <- struct{}{}:
	case <-ctx.Done():
		r.metrics.Rejected.Add(1)
		r.tasks.Delete(t.ID) // 没执行就撤销占坑，允许重试
		return t, fmt.Errorf("%w (租户额度)", ErrBusy)
	}
	select {
	case r.sem <- struct{}{}:
	case <-ctx.Done():
		<-tsem
		r.metrics.Rejected.Add(1)
		r.tasks.Delete(t.ID)
		return t, fmt.Errorf("%w (全局额度)", ErrBusy)
	}

	go func() {
		// ⚠️ 名额必须归还 —— panic 也要还，否则并发额度会逐渐降到 0，Runner 假死
		defer func() {
			<-r.sem
			<-tsem
			r.metrics.Running.Add(-1)
			if rec := recover(); rec != nil {
				r.events(t.ID, "panic", "recover", rec)
				t.To(StateFailed) // 保证进入终态 → 清理钩子被触发
			}
		}()

		if !t.To(StateRunning) {
			return // 已被取消（Pending → Canceled），不执行
		}
		r.metrics.Running.Add(1)
		r.events(t.ID, "started")

		if err := r.executor.Execute(context.Background(), t, sink); err != nil {
			r.events(t.ID, "execute_error", "err", err)
			t.To(StateFailed) // 启动失败：没有子进程，单独归类
		}
		// 正常路径下 executor 内部的 classify 已完成终态迁移
	}()

	return t, nil
}

// Cancel 用户取消 —— 与超时走同一条终止路径
func (r *Runner) Cancel(taskID string) error {
	v, ok := r.tasks.Load(taskID)
	if !ok {
		return ErrNoSuchTask
	}
	t := v.(*Task)
	if !t.To(StateCanceled) {
		// 迁移失败 = 任务已进终态。这不是错误，是"迟到的取消"被正确拒绝
		return fmt.Errorf("任务已处于终态 %s，取消被忽略", t.State())
	}
	r.events(taskID, "canceled_by_user")
	return nil
}

func (r *Runner) Get(taskID string) (*Task, bool) {
	v, ok := r.tasks.Load(taskID)
	if !ok {
		return nil, false
	}
	return v.(*Task), true
}

// WaitAll 等所有任务进入终态（demo / 优雅关闭用）
func (r *Runner) WaitAll(timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if r.metrics.Running.Load() == 0 && len(r.sem) == 0 {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}

func (r *Runner) Metrics() *Metrics { return r.metrics }
