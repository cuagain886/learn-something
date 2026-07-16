package web

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHandlerExposesBuildIdentity(t *testing.T) {
	handler := NewHandler(Info{Version: "1.2.3", Commit: "abc123", Message: "test"})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	body := recorder.Body.String()
	for _, expected := range []string{"1.2.3", "abc123", "test"} {
		if !strings.Contains(body, expected) {
			t.Fatalf("body = %q, want %q", body, expected)
		}
	}
}
