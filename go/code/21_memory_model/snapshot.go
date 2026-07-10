package main

import (
	"sync"
	"sync/atomic"
	"time"
)

// Config 是适合整份发布的只读配置快照。
// 字段本身都是值语义；Load 返回副本，调用者无法修改已发布版本。
type Config struct {
	Version  int64
	Endpoint string
	Timeout  time.Duration
}

// AtomicSnapshot 使用原子指针一次性发布整份 Config。
// 读者要么看到旧版本，要么看到新版本，不会看到字段混合的中间状态。
type AtomicSnapshot struct {
	value atomic.Pointer[Config]
}

func NewAtomicSnapshot(initial Config) *AtomicSnapshot {
	snapshot := &AtomicSnapshot{}
	snapshot.Store(initial)
	return snapshot
}

func (s *AtomicSnapshot) Load() Config {
	current := s.value.Load()
	if current == nil {
		return Config{}
	}
	return *current
}

func (s *AtomicSnapshot) Store(next Config) {
	copyOfNext := next
	s.value.Store(&copyOfNext)
}

// LockedSnapshot 用 RWMutex 提供与 AtomicSnapshot 相同的发布语义。
// 它适用于写操作更复杂、需要在同一临界区维护多个可变状态的场景。
type LockedSnapshot struct {
	mu    sync.RWMutex
	value Config
}

func NewLockedSnapshot(initial Config) *LockedSnapshot {
	return &LockedSnapshot{value: initial}
}

func (s *LockedSnapshot) Load() Config {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.value
}

func (s *LockedSnapshot) Store(next Config) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.value = next
}
