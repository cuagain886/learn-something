package api

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"learn_go/28_production_service/internal/jobs"
	"learn_go/28_production_service/internal/observability"
)

type fakeJobService struct {
	submit func(context.Context, string) (jobs.Job, error)
	get    func(string) (jobs.Job, bool)
}

func (s fakeJobService) Submit(ctx context.Context, payload string) (jobs.Job, error) {
	return s.submit(ctx, payload)
}

func (s fakeJobService) Get(id string) (jobs.Job, bool) {
	return s.get(id)
}

type fixedLimiter bool

func (l fixedLimiter) Allow() bool { return bool(l) }

func TestHandlerMapsProtocolAndServiceOutcomes(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	accepted := jobs.Job{ID: "job-1", Status: jobs.Queued, CreatedAt: time.Now()}
	succeeded := jobs.Job{ID: "job-1", Status: jobs.Succeeded, Result: "GO"}

	tests := []struct {
		name     string
		method   string
		path     string
		body     string
		maxBody  int64
		limiter  fixedLimiter
		service  fakeJobService
		wantCode int
	}{
		{
			name:   "accepted",
			method: http.MethodPost, path: "/v1/jobs", body: `{"payload":"go"}`, maxBody: 1024, limiter: true,
			service: fakeJobService{
				submit: func(context.Context, string) (jobs.Job, error) { return accepted, nil },
				get:    func(string) (jobs.Job, bool) { return jobs.Job{}, false },
			},
			wantCode: http.StatusAccepted,
		},
		{
			name:   "invalid json",
			method: http.MethodPost, path: "/v1/jobs", body: `{"payload":`, maxBody: 1024, limiter: true,
			service: noOpService(), wantCode: http.StatusBadRequest,
		},
		{
			name:   "body too large",
			method: http.MethodPost, path: "/v1/jobs", body: `{"payload":"this is too large"}`, maxBody: 8, limiter: true,
			service: noOpService(), wantCode: http.StatusRequestEntityTooLarge,
		},
		{
			name:   "rate limited",
			method: http.MethodPost, path: "/v1/jobs", body: `{"payload":"go"}`, maxBody: 1024, limiter: false,
			service: noOpService(), wantCode: http.StatusTooManyRequests,
		},
		{
			name:   "queue full",
			method: http.MethodPost, path: "/v1/jobs", body: `{"payload":"go"}`, maxBody: 1024, limiter: true,
			service: fakeJobService{
				submit: func(context.Context, string) (jobs.Job, error) { return jobs.Job{}, jobs.ErrQueueFull },
				get:    func(string) (jobs.Job, bool) { return jobs.Job{}, false },
			},
			wantCode: http.StatusServiceUnavailable,
		},
		{
			name:   "not found",
			method: http.MethodGet, path: "/v1/jobs/missing", maxBody: 1024, limiter: true,
			service: noOpService(), wantCode: http.StatusNotFound,
		},
		{
			name:   "query succeeded",
			method: http.MethodGet, path: "/v1/jobs/job-1", maxBody: 1024, limiter: true,
			service: fakeJobService{
				submit: func(context.Context, string) (jobs.Job, error) { return jobs.Job{}, nil },
				get:    func(string) (jobs.Job, bool) { return succeeded, true },
			},
			wantCode: http.StatusOK,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			metrics := &observability.Metrics{}
			handler, err := NewHandler(tt.service, tt.limiter, metrics, logger, tt.maxBody)
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(tt.method, tt.path, strings.NewReader(tt.body))
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)

			if response.Code != tt.wantCode {
				t.Fatalf("status = %d body=%s, want %d", response.Code, response.Body.String(), tt.wantCode)
			}
			if contentType := response.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "application/json") {
				t.Fatalf("Content-Type = %q", contentType)
			}
			if requestID := response.Header().Get("X-Request-ID"); requestID == "" {
				t.Fatal("X-Request-ID is empty")
			}
		})
	}
}

func noOpService() fakeJobService {
	return fakeJobService{
		submit: func(context.Context, string) (jobs.Job, error) { return jobs.Job{}, errors.New("unexpected submit") },
		get:    func(string) (jobs.Job, bool) { return jobs.Job{}, false },
	}
}

func TestHandlerRecoversPanicAndRecordsMetrics(t *testing.T) {
	metrics := &observability.Metrics{}
	handler, err := NewHandler(fakeJobService{
		submit: func(context.Context, string) (jobs.Job, error) { panic("handler boom") },
		get:    func(string) (jobs.Job, bool) { return jobs.Job{}, false },
	}, fixedLimiter(true), metrics, slog.New(slog.NewTextHandler(io.Discard, nil)), 1024)
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/jobs", strings.NewReader(`{"payload":"go"}`)))
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	snapshot := metrics.Snapshot()
	if snapshot.PanicsTotal != 1 || snapshot.RequestsTotal != 1 || snapshot.RequestErrorsTotal != 1 || snapshot.InFlight != 0 {
		t.Fatalf("metrics = %+v", snapshot)
	}
}

func TestHandlerReturnsJSONForUnknownRoutesAndMethods(t *testing.T) {
	handler, err := NewHandler(noOpService(), fixedLimiter(true), &observability.Metrics{},
		slog.New(slog.NewTextHandler(io.Discard, nil)), 1024)
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		method string
		path   string
		status int
	}{
		{http.MethodGet, "/v1/jobs", http.StatusMethodNotAllowed},
		{http.MethodGet, "/unknown", http.StatusNotFound},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		if response.Code != test.status {
			t.Fatalf("%s %s status = %d, want %d", test.method, test.path, response.Code, test.status)
		}
		if contentType := response.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "application/json") {
			t.Fatalf("%s %s Content-Type = %q", test.method, test.path, contentType)
		}
	}
}
