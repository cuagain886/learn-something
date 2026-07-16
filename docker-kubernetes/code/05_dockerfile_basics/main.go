package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

type config struct {
	Port            string
	Message         string
	ShutdownTimeout time.Duration
}

func loadConfig(getenv func(string) string) (config, error) {
	cfg := config{
		Port:            valueOrDefault(getenv("PORT"), "8080"),
		Message:         valueOrDefault(getenv("MESSAGE"), "hello from lesson 05"),
		ShutdownTimeout: 5 * time.Second,
	}

	if strings.Contains(cfg.Port, ":") || strings.TrimSpace(cfg.Port) == "" {
		return config{}, fmt.Errorf("PORT must be a port number, got %q", cfg.Port)
	}
	return cfg, nil
}

func valueOrDefault(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func newHandler(cfg config) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{
			"message": cfg.Message,
			"lesson":  "05_dockerfile_basics",
		})
	})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
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

func run(ctx context.Context, cfg config) error {
	server := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           newHandler(cfg),
		ReadHeaderTimeout: 3 * time.Second,
		WriteTimeout:      5 * time.Second,
		IdleTimeout:       30 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		slog.Info("server started", "address", server.Addr, "message", cfg.Message)
		errCh <- server.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		slog.Info("shutdown requested")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
		defer cancel()
		return server.Shutdown(shutdownCtx)
	}
}

func main() {
	cfg, err := loadConfig(os.Getenv)
	if err != nil {
		slog.Error("invalid configuration", "error", err)
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := run(ctx, cfg); err != nil {
		slog.Error("server stopped with error", "error", err)
		os.Exit(1)
	}
}
