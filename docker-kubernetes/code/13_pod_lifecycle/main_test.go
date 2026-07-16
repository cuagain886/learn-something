package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestReadinessWarmsUp(t *testing.T) {
	handler := newHandler(time.Now(), time.Hour)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", recorder.Code)
	}
}

func TestReadinessEventuallySucceeds(t *testing.T) {
	handler := newHandler(time.Now().Add(-time.Hour), time.Second)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
}
