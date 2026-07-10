package app

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"learn_go/28_production_service/internal/config"
	"learn_go/28_production_service/internal/observability"
)

type callLog struct {
	mu    sync.Mutex
	calls []string
}

func (l *callLog) add(call string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.calls = append(l.calls, call)
}

type fakeReadiness struct{ log *callLog }

func (r fakeReadiness) Store(ready bool) {
	if !ready {
		r.log.add("not-ready")
	}
}

type fakeShutdowner struct {
	name string
	log  *callLog
}

func (s fakeShutdowner) Shutdown(context.Context) error {
	s.log.add(s.name)
	return nil
}

func TestCoordinatorShutdownOrder(t *testing.T) {
	log := &callLog{}
	coordinator := Coordinator{
		Readiness: fakeReadiness{log},
		Business:  fakeShutdowner{"business", log},
		Engine:    fakeShutdowner{"engine", log},
		Debug:     fakeShutdowner{"debug", log},
	}
	if err := coordinator.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	want := []string{"not-ready", "business", "engine", "debug"}
	if len(log.calls) != len(want) {
		t.Fatalf("calls = %v, want %v", log.calls, want)
	}
	for index := range want {
		if log.calls[index] != want[index] {
			t.Fatalf("calls = %v, want %v", log.calls, want)
		}
	}
}

func TestDebugHandlerHealthReadinessMetricsAndPprof(t *testing.T) {
	metrics := &observability.Metrics{}
	readiness := NewReadiness()
	handler := NewDebugHandler(metrics, readiness)

	for _, test := range []struct {
		path   string
		status int
		json   bool
	}{
		{"/healthz", http.StatusOK, true},
		{"/readyz", http.StatusOK, true},
		{"/metrics", http.StatusOK, false},
		{"/debug/pprof/", http.StatusOK, false},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, test.path, nil))
		if response.Code != test.status {
			t.Fatalf("GET %s status = %d", test.path, response.Code)
		}
		if test.json && !json.Valid(response.Body.Bytes()) {
			t.Fatalf("GET %s returned invalid JSON: %q", test.path, response.Body.String())
		}
	}

	readiness.Store(false)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if response.Code != http.StatusServiceUnavailable || !json.Valid(response.Body.Bytes()) {
		t.Fatalf("not-ready response = %d %q", response.Code, response.Body.String())
	}
}

func TestRunStopsCleanlyWhenRootContextEnds(t *testing.T) {
	cfg := config.Default()
	cfg.Addr = "127.0.0.1:0"
	cfg.DebugAddr = "127.0.0.1:0"
	cfg.ShutdownTimeout = time.Second
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := Run(ctx, cfg, logger); err != nil {
		t.Fatalf("Run() = %v, want nil", err)
	}
}
