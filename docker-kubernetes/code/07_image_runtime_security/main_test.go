package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRootHandlerReportsRuntimeIdentity(t *testing.T) {
	recorder := httptest.NewRecorder()
	newHandler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	for _, field := range []string{`"uid"`, `"gid"`, `"version"`} {
		if !strings.Contains(recorder.Body.String(), field) {
			t.Fatalf("body = %q, want field %s", recorder.Body.String(), field)
		}
	}
}

func TestHealthcheckRejectsUnavailableEndpoint(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := healthcheck(ctx); err == nil {
		t.Fatal("expected canceled healthcheck to fail")
	}
}
