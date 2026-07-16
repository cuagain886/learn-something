package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestLoadConfigUsesDefaults(t *testing.T) {
	cfg, err := loadConfig(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Port != "8080" || cfg.Message != "hello from lesson 05" {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
}

func TestLoadConfigRejectsAddressInsteadOfPort(t *testing.T) {
	_, err := loadConfig(func(key string) string {
		if key == "PORT" {
			return "127.0.0.1:8080"
		}
		return ""
	})
	if err == nil {
		t.Fatal("expected invalid PORT error")
	}
}

func TestRootHandlerUsesRuntimeMessage(t *testing.T) {
	handler := newHandler(config{Message: "configured at runtime"})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), "configured at runtime") {
		t.Fatalf("body = %q, want runtime message", recorder.Body.String())
	}
}
