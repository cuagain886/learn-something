package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	httppprof "net/http/pprof"
	"sync/atomic"
	"time"

	"learn_go/28_production_service/internal/api"
	"learn_go/28_production_service/internal/config"
	"learn_go/28_production_service/internal/jobs"
	"learn_go/28_production_service/internal/observability"
	"learn_go/28_production_service/internal/resilience"
)

var ErrInvalidAppConfig = errors.New("invalid application configuration")

type readinessSetter interface {
	Store(bool)
}

type shutdowner interface {
	Shutdown(context.Context) error
}

type Coordinator struct {
	Readiness readinessSetter
	Business  shutdowner
	Engine    shutdowner
	Debug     shutdowner
}

func (c Coordinator) Shutdown(ctx context.Context) error {
	if ctx == nil || c.Readiness == nil || c.Business == nil || c.Engine == nil || c.Debug == nil {
		return ErrInvalidAppConfig
	}
	c.Readiness.Store(false)
	return errors.Join(
		c.Business.Shutdown(ctx),
		c.Engine.Shutdown(ctx),
		c.Debug.Shutdown(ctx),
	)
}

type Readiness struct {
	ready atomic.Bool
}

func NewReadiness() *Readiness {
	readiness := &Readiness{}
	readiness.ready.Store(true)
	return readiness
}

func (r *Readiness) Store(ready bool) { r.ready.Store(ready) }
func (r *Readiness) Ready() bool      { return r.ready.Load() }

func Run(ctx context.Context, cfg config.Config, logger *slog.Logger) error {
	if ctx == nil || logger == nil {
		return ErrInvalidAppConfig
	}
	if err := cfg.Validate(); err != nil {
		return err
	}

	metrics := &observability.Metrics{}
	limiter, err := resilience.NewTokenBucket(cfg.RatePerSecond, cfg.Burst, time.Now)
	if err != nil {
		return err
	}
	breaker, err := resilience.NewBreaker(5, 5*time.Second, time.Now)
	if err != nil {
		return err
	}
	retry := &resilience.RetryExecutor{
		Next:   hashExecutor{},
		Config: resilience.RetryConfig{MaxAttempts: 3, BaseDelay: 10 * time.Millisecond, MaxDelay: 100 * time.Millisecond},
	}
	executor := &resilience.CircuitExecutor{Next: retry, Breaker: breaker}
	engine, err := jobs.NewEngine(context.WithoutCancel(ctx), cfg.Workers, cfg.QueueSize, cfg.TaskTimeout, executor)
	if err != nil {
		return err
	}

	businessHandler, err := api.NewHandler(engine, limiter, metrics, logger, cfg.MaxBodyBytes)
	if err != nil {
		_ = engine.Shutdown(context.Background())
		return err
	}
	readiness := NewReadiness()
	businessServer := &http.Server{
		Handler:           businessHandler,
		ReadHeaderTimeout: 2 * time.Second,
		ReadTimeout:       5 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
	debugServer := &http.Server{
		Handler:           NewDebugHandler(metrics, readiness),
		ReadHeaderTimeout: 2 * time.Second,
		ReadTimeout:       5 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       30 * time.Second,
	}

	businessListener, err := net.Listen("tcp", cfg.Addr)
	if err != nil {
		_ = engine.Shutdown(context.Background())
		return fmt.Errorf("listen business: %w", err)
	}
	debugListener, err := net.Listen("tcp", cfg.DebugAddr)
	if err != nil {
		_ = businessListener.Close()
		_ = engine.Shutdown(context.Background())
		return fmt.Errorf("listen debug: %w", err)
	}
	logger.Info("service started", "business_addr", businessListener.Addr(), "debug_addr", debugListener.Addr())

	type serveResult struct {
		name string
		err  error
	}
	serveErrors := make(chan serveResult, 2)
	go func() { serveErrors <- serveResult{"business", businessServer.Serve(businessListener)} }()
	go func() { serveErrors <- serveResult{"debug", debugServer.Serve(debugListener)} }()

	var triggerErr error
	select {
	case <-ctx.Done():
	case result := <-serveErrors:
		if !errors.Is(result.err, http.ErrServerClosed) {
			triggerErr = fmt.Errorf("%s server: %w", result.name, result.err)
		}
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	coordinator := Coordinator{Readiness: readiness, Business: businessServer, Engine: engine, Debug: debugServer}
	shutdownErr := coordinator.Shutdown(shutdownCtx)
	logger.Info("service stopped", "trigger_error", triggerErr, "shutdown_error", shutdownErr)
	return errors.Join(triggerErr, shutdownErr)
}

func NewDebugHandler(metrics *observability.Metrics, readiness *Readiness) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /metrics", metrics)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte(`{"status":"ok"}` + "\n"))
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		if !readiness.Ready() {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"status":"not_ready"}` + "\n"))
			return
		}
		_, _ = w.Write([]byte(`{"status":"ready"}` + "\n"))
	})
	mux.HandleFunc("/debug/pprof/", httppprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", httppprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", httppprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", httppprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", httppprof.Trace)
	return mux
}

type hashExecutor struct{}

func (hashExecutor) Execute(ctx context.Context, payload string) (string, error) {
	value := []byte(payload)
	for iteration := 0; iteration < 2_048; iteration++ {
		if iteration%128 == 0 {
			select {
			case <-ctx.Done():
				return "", context.Cause(ctx)
			default:
			}
		}
		sum := sha256.Sum256(value)
		value = sum[:]
	}
	return hex.EncodeToString(value), nil
}
