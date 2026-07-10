package jobs

import "sync"

type Store struct {
	mu   sync.RWMutex
	jobs map[string]Job
}

func NewStore() *Store {
	return &Store{jobs: make(map[string]Job)}
}

func (s *Store) Put(job Job) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.jobs[job.ID] = job
}

func (s *Store) Get(id string) (Job, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	job, ok := s.jobs[id]
	return job, ok
}

func (s *Store) Update(id string, update func(*Job)) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	job, ok := s.jobs[id]
	if !ok {
		return false
	}
	update(&job)
	s.jobs[id] = job
	return true
}

func (s *Store) Delete(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.jobs, id)
}
