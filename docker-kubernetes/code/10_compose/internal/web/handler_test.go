package web

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

type fakeCounter struct {
	count   int64
	pingErr error
	incrErr error
}

func (f fakeCounter) Ping(context.Context) error { return f.pingErr }
func (f fakeCounter) Incr(context.Context, string) (int64, error) {
	return f.count, f.incrErr
}

func TestRootReturnsCount(t *testing.T) {
	recorder := httptest.NewRecorder()
	NewHandler(fakeCounter{count: 7}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
}

func TestRootReturnsUnavailableWhenRedisFails(t *testing.T) {
	recorder := httptest.NewRecorder()
	NewHandler(fakeCounter{incrErr: errors.New("redis down")}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", recorder.Code)
	}
}

func TestReadinessDependsOnRedis(t *testing.T) {
	recorder := httptest.NewRecorder()
	NewHandler(fakeCounter{pingErr: errors.New("redis down")}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", recorder.Code)
	}
}
