package observability

import (
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestMetricsSnapshotAndTextFormat(t *testing.T) {
	metrics := &Metrics{}
	metrics.RequestStarted()
	metrics.JobSubmitted()
	metrics.JobRejected()
	metrics.Panic()
	metrics.RequestFinished(500)

	snapshot := metrics.Snapshot()
	if snapshot.RequestsTotal != 1 || snapshot.RequestErrorsTotal != 1 || snapshot.JobsSubmittedTotal != 1 ||
		snapshot.JobsRejectedTotal != 1 || snapshot.PanicsTotal != 1 || snapshot.InFlight != 0 {
		t.Fatalf("Snapshot() = %+v", snapshot)
	}
	response := httptest.NewRecorder()
	metrics.ServeHTTP(response, httptest.NewRequest("GET", "/metrics", nil))
	wantLines := []string{
		"requests_total 1",
		"request_errors_total 1",
		"jobs_submitted_total 1",
		"jobs_rejected_total 1",
		"panics_total 1",
		"in_flight 0",
	}
	for _, line := range wantLines {
		if !strings.Contains(response.Body.String(), line+"\n") {
			t.Fatalf("metrics body missing %q: %s", line, response.Body.String())
		}
	}
}

func TestMetricsAreConcurrentSafe(t *testing.T) {
	metrics := &Metrics{}
	var workers sync.WaitGroup
	for range 100 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			metrics.RequestStarted()
			metrics.RequestFinished(200)
		}()
	}
	workers.Wait()
	if snapshot := metrics.Snapshot(); snapshot.RequestsTotal != 100 || snapshot.InFlight != 0 {
		t.Fatalf("Snapshot() = %+v", snapshot)
	}
}
