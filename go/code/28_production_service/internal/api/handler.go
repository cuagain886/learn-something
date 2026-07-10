package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"runtime/debug"
	"strings"
	"sync/atomic"
	"time"

	"learn_go/28_production_service/internal/jobs"
	"learn_go/28_production_service/internal/observability"
)

var ErrInvalidHandlerConfig = errors.New("invalid API handler configuration")

type JobService interface {
	Submit(context.Context, string) (jobs.Job, error)
	Get(string) (jobs.Job, bool)
}

type Limiter interface {
	Allow() bool
}

type handler struct {
	service JobService
	limiter Limiter
	metrics *observability.Metrics
	logger  *slog.Logger
	maxBody int64
	nextID  atomic.Uint64
}

type requestIDKey struct{}

func NewHandler(service JobService, limiter Limiter, metrics *observability.Metrics, logger *slog.Logger, maxBody int64) (http.Handler, error) {
	if service == nil || limiter == nil || metrics == nil || logger == nil || maxBody <= 0 {
		return nil, ErrInvalidHandlerConfig
	}
	h := &handler{service: service, limiter: limiter, metrics: metrics, logger: logger, maxBody: maxBody}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/jobs", h.submitJob)
	mux.HandleFunc("GET /v1/jobs/{id}", h.getJob)
	mux.HandleFunc("/v1/jobs", h.methodNotAllowed)
	mux.HandleFunc("/v1/jobs/{id}", h.methodNotAllowed)
	mux.HandleFunc("/", h.notFound)

	var result http.Handler = mux
	result = h.withLimit(result)
	result = h.withRecovery(result)
	result = h.withObservation(result)
	result = h.withRequestID(result)
	return result, nil
}

func (h *handler) submitJob(w http.ResponseWriter, request *http.Request) {
	defer request.Body.Close()
	request.Body = http.MaxBytesReader(w, request.Body, h.maxBody)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var input struct {
		Payload string `json:"payload"`
	}
	if err := decoder.Decode(&input); err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			h.writeError(w, request, http.StatusRequestEntityTooLarge, "body_too_large", "request body is too large")
			return
		}
		h.writeError(w, request, http.StatusBadRequest, "invalid_json", "request body must be one JSON object")
		return
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		h.writeError(w, request, http.StatusBadRequest, "invalid_json", "request body must contain exactly one JSON object")
		return
	}
	if strings.TrimSpace(input.Payload) == "" {
		h.writeError(w, request, http.StatusBadRequest, "invalid_payload", "payload is required")
		return
	}

	job, err := h.service.Submit(request.Context(), input.Payload)
	if err != nil {
		h.metrics.JobRejected()
		switch {
		case errors.Is(err, jobs.ErrQueueFull), errors.Is(err, jobs.ErrClosed):
			h.writeError(w, request, http.StatusServiceUnavailable, "service_overloaded", "service cannot accept more jobs")
		case errors.Is(err, context.DeadlineExceeded):
			h.writeError(w, request, http.StatusGatewayTimeout, "deadline_exceeded", "job submission deadline exceeded")
		default:
			h.logger.Error("submit job failed", "request_id", requestID(request.Context()), "error", err)
			h.writeError(w, request, http.StatusInternalServerError, "internal_error", "internal server error")
		}
		return
	}
	h.metrics.JobSubmitted()
	h.writeJSON(w, http.StatusAccepted, job)
}

func (h *handler) getJob(w http.ResponseWriter, request *http.Request) {
	job, ok := h.service.Get(request.PathValue("id"))
	if !ok {
		h.writeError(w, request, http.StatusNotFound, "job_not_found", "job was not found")
		return
	}
	h.writeJSON(w, http.StatusOK, job)
}

func (h *handler) methodNotAllowed(w http.ResponseWriter, request *http.Request) {
	w.Header().Set("Allow", "POST")
	if request.URL.Path != "/v1/jobs" {
		w.Header().Set("Allow", "GET")
	}
	h.writeError(w, request, http.StatusMethodNotAllowed, "method_not_allowed", "HTTP method is not allowed for this resource")
}

func (h *handler) notFound(w http.ResponseWriter, request *http.Request) {
	h.writeError(w, request, http.StatusNotFound, "route_not_found", "route was not found")
}

func (h *handler) withRequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		id := strings.TrimSpace(request.Header.Get("X-Request-ID"))
		if id == "" || len(id) > 128 {
			id = fmt.Sprintf("req-%x", h.nextID.Add(1))
		}
		w.Header().Set("X-Request-ID", id)
		ctx := context.WithValue(request.Context(), requestIDKey{}, id)
		next.ServeHTTP(w, request.WithContext(ctx))
	})
}

func (h *handler) withObservation(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		start := time.Now()
		recorder := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		h.metrics.RequestStarted()
		defer func() {
			h.metrics.RequestFinished(recorder.status)
			h.logger.Info("HTTP request",
				"request_id", requestID(request.Context()),
				"method", request.Method,
				"path", request.URL.Path,
				"status", recorder.status,
				"duration", time.Since(start),
			)
		}()
		next.ServeHTTP(recorder, request)
	})
}

func (h *handler) withRecovery(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		defer func() {
			if recovered := recover(); recovered != nil {
				h.metrics.Panic()
				h.logger.Error("HTTP handler panicked", "request_id", requestID(request.Context()), "panic", recovered, "stack", string(debug.Stack()))
				h.writeError(w, request, http.StatusInternalServerError, "internal_error", "internal server error")
			}
		}()
		next.ServeHTTP(w, request)
	})
}

func (h *handler) withLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if !h.limiter.Allow() {
			if request.Method == http.MethodPost {
				h.metrics.JobRejected()
			}
			h.writeError(w, request, http.StatusTooManyRequests, "rate_limited", "request rate exceeded")
			return
		}
		next.ServeHTTP(w, request)
	})
}

func (h *handler) writeError(w http.ResponseWriter, request *http.Request, status int, code, message string) {
	h.writeJSON(w, status, map[string]any{
		"error":      map[string]string{"code": code, "message": message},
		"request_id": requestID(request.Context()),
	})
}

func (h *handler) writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		h.logger.Error("encode response failed", "error", err)
	}
}

func requestID(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey{}).(string)
	return id
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (w *statusRecorder) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusRecorder) Write(body []byte) (int, error) {
	return w.ResponseWriter.Write(body)
}

func (w *statusRecorder) Unwrap() http.ResponseWriter { return w.ResponseWriter }
