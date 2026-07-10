package api

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"learn_go/28_production_service/internal/jobs"
	"learn_go/28_production_service/internal/observability"
)

func BenchmarkSubmitHandler(b *testing.B) {
	service := fakeJobService{
		submit: func(context.Context, string) (jobs.Job, error) {
			return jobs.Job{ID: "job-bench", Status: jobs.Queued}, nil
		},
		get: func(string) (jobs.Job, bool) { return jobs.Job{}, false },
	}
	handler, err := NewHandler(service, fixedLimiter(true), &observability.Metrics{},
		slog.New(slog.NewTextHandler(io.Discard, nil)), 1024)
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	for b.Loop() {
		request := httptest.NewRequest(http.MethodPost, "/v1/jobs", strings.NewReader(`{"payload":"go"}`))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusAccepted {
			b.Fatalf("status = %d", response.Code)
		}
	}
}
