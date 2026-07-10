package observability

import (
	"fmt"
	"net/http"
	"sync/atomic"
)

type Snapshot struct {
	RequestsTotal      uint64
	RequestErrorsTotal uint64
	JobsSubmittedTotal uint64
	JobsRejectedTotal  uint64
	PanicsTotal        uint64
	InFlight           int64
}

type Metrics struct {
	requestsTotal      atomic.Uint64
	requestErrorsTotal atomic.Uint64
	jobsSubmittedTotal atomic.Uint64
	jobsRejectedTotal  atomic.Uint64
	panicsTotal        atomic.Uint64
	inFlight           atomic.Int64
}

func (m *Metrics) RequestStarted() {
	m.requestsTotal.Add(1)
	m.inFlight.Add(1)
}

func (m *Metrics) RequestFinished(status int) {
	if status >= http.StatusBadRequest {
		m.requestErrorsTotal.Add(1)
	}
	m.inFlight.Add(-1)
}

func (m *Metrics) JobSubmitted() { m.jobsSubmittedTotal.Add(1) }
func (m *Metrics) JobRejected()  { m.jobsRejectedTotal.Add(1) }
func (m *Metrics) Panic()        { m.panicsTotal.Add(1) }

func (m *Metrics) Snapshot() Snapshot {
	return Snapshot{
		RequestsTotal:      m.requestsTotal.Load(),
		RequestErrorsTotal: m.requestErrorsTotal.Load(),
		JobsSubmittedTotal: m.jobsSubmittedTotal.Load(),
		JobsRejectedTotal:  m.jobsRejectedTotal.Load(),
		PanicsTotal:        m.panicsTotal.Load(),
		InFlight:           m.inFlight.Load(),
	}
}

func (m *Metrics) ServeHTTP(w http.ResponseWriter, _ *http.Request) {
	snapshot := m.Snapshot()
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	_, _ = fmt.Fprintf(w,
		"requests_total %d\nrequest_errors_total %d\njobs_submitted_total %d\njobs_rejected_total %d\npanics_total %d\nin_flight %d\n",
		snapshot.RequestsTotal,
		snapshot.RequestErrorsTotal,
		snapshot.JobsSubmittedTotal,
		snapshot.JobsRejectedTotal,
		snapshot.PanicsTotal,
		snapshot.InFlight,
	)
}
