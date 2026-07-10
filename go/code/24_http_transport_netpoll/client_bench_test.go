package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func BenchmarkHandlerPath(b *testing.B) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = io.WriteString(w, request.URL.Query().Get("value"))
	})
	b.ReportAllocs()
	for b.Loop() {
		request := httptest.NewRequest(http.MethodGet, "/work?value=go", nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			b.Fatalf("status = %d", response.Code)
		}
	}
}
