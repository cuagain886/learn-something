package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"learn_go/28_production_service/internal/api"
	"learn_go/28_production_service/internal/jobs"
	"learn_go/28_production_service/internal/observability"
	"learn_go/28_production_service/internal/resilience"
)

type integrationExecutor struct{}

func (integrationExecutor) Execute(_ context.Context, payload string) (string, error) {
	return strings.ToUpper(payload), nil
}

func TestJobServiceHTTPFlow(t *testing.T) {
	engine, err := jobs.NewEngine(context.Background(), 2, 8, time.Second, integrationExecutor{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = engine.Shutdown(context.Background()) })
	limiter, err := resilience.NewTokenBucket(1_000, 10, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	handler, err := api.NewHandler(engine, limiter, &observability.Metrics{},
		slog.New(slog.NewTextHandler(io.Discard, nil)), 1024)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	defer server.Close()

	response, err := server.Client().Post(server.URL+"/v1/jobs", "application/json", bytes.NewBufferString(`{"payload":"go"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusAccepted {
		body, _ := io.ReadAll(response.Body)
		t.Fatalf("POST status=%d body=%s", response.StatusCode, body)
	}
	var submitted jobs.Job
	if err := json.NewDecoder(response.Body).Decode(&submitted); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(time.Second)
	for {
		query, err := server.Client().Get(server.URL + "/v1/jobs/" + submitted.ID)
		if err != nil {
			t.Fatal(err)
		}
		var current jobs.Job
		decodeErr := json.NewDecoder(query.Body).Decode(&current)
		query.Body.Close()
		if decodeErr != nil {
			t.Fatal(decodeErr)
		}
		if current.Status == jobs.Succeeded {
			if current.Result != "GO" {
				t.Fatalf("job result = %q, want GO", current.Result)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("job status = %s, want succeeded", current.Status)
		}
		time.Sleep(time.Millisecond)
	}
}

type integrationTemporaryError struct{}

func (integrationTemporaryError) Error() string   { return "temporary" }
func (integrationTemporaryError) Temporary() bool { return true }

type flakyIntegrationExecutor struct{ attempts atomic.Int64 }

func (e *flakyIntegrationExecutor) Execute(context.Context, string) (string, error) {
	if e.attempts.Add(1) < 3 {
		return "", integrationTemporaryError{}
	}
	return "ok", nil
}

func TestEngineReportsRetryAttempts(t *testing.T) {
	flaky := &flakyIntegrationExecutor{}
	retry := &resilience.RetryExecutor{
		Next:   flaky,
		Config: resilience.RetryConfig{MaxAttempts: 3},
	}
	engine, err := jobs.NewEngine(context.Background(), 1, 1, time.Second, retry)
	if err != nil {
		t.Fatal(err)
	}
	job, err := engine.Submit(context.Background(), "retry")
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for {
		current, _ := engine.Get(job.ID)
		if current.Status == jobs.Succeeded {
			if current.Attempts != 3 {
				t.Fatalf("Job.Attempts = %d, want 3", current.Attempts)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("job status = %s", current.Status)
		}
		time.Sleep(time.Millisecond)
	}
	if err := engine.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
}
