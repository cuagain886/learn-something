package web

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"
)

type Counter interface {
	Ping(context.Context) error
	Incr(context.Context, string) (int64, error)
}

func NewHandler(counter Counter) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), time.Second)
		defer cancel()
		count, err := counter.Incr(ctx, "page_hits")
		if err != nil {
			slog.Warn("increment failed", "error", err)
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "counter dependency unavailable"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"message": "hello from Compose", "count": count})
	})
	mux.HandleFunc("GET /livez", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "alive"})
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 500*time.Millisecond)
		defer cancel()
		if err := counter.Ping(ctx); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "not-ready"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
	})
	return mux
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		slog.Error("write response", "error", err)
	}
}
