package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptrace"
	"sync"
	"time"
)

var ErrInvalidClientConfig = errors.New("invalid HTTP client configuration")

type ClientConfig struct {
	RequestTimeout        time.Duration
	DialTimeout           time.Duration
	TLSHandshakeTimeout   time.Duration
	ResponseHeaderTimeout time.Duration
	IdleConnTimeout       time.Duration
	MaxIdleConns          int
	MaxIdleConnsPerHost   int
}

func NewClient(config ClientConfig) (*http.Client, error) {
	if config.RequestTimeout < 0 ||
		config.DialTimeout < 0 ||
		config.TLSHandshakeTimeout < 0 ||
		config.ResponseHeaderTimeout < 0 ||
		config.IdleConnTimeout < 0 ||
		config.MaxIdleConns < 0 ||
		config.MaxIdleConnsPerHost < 0 {
		return nil, ErrInvalidClientConfig
	}

	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = (&net.Dialer{
		Timeout:   config.DialTimeout,
		KeepAlive: 30 * time.Second,
	}).DialContext
	transport.TLSHandshakeTimeout = config.TLSHandshakeTimeout
	transport.ResponseHeaderTimeout = config.ResponseHeaderTimeout
	transport.IdleConnTimeout = config.IdleConnTimeout
	transport.MaxIdleConns = config.MaxIdleConns
	transport.MaxIdleConnsPerHost = config.MaxIdleConnsPerHost

	return &http.Client{
		Transport: transport,
		Timeout:   config.RequestTimeout,
	}, nil
}

type TraceSnapshot struct {
	Connections   []httptrace.GotConnInfo
	ConnectStarts int
	ConnectDones  int
}

type TraceEvents struct {
	mu sync.Mutex

	connections   []httptrace.GotConnInfo
	connectStarts int
	connectDones  int
}

func WithTrace(ctx context.Context, events *TraceEvents) context.Context {
	trace := &httptrace.ClientTrace{
		ConnectStart: func(_, _ string) {
			events.mu.Lock()
			events.connectStarts++
			events.mu.Unlock()
		},
		ConnectDone: func(_, _ string, _ error) {
			events.mu.Lock()
			events.connectDones++
			events.mu.Unlock()
		},
		GotConn: func(info httptrace.GotConnInfo) {
			events.mu.Lock()
			events.connections = append(events.connections, info)
			events.mu.Unlock()
		},
	}
	return httptrace.WithClientTrace(ctx, trace)
}

func (e *TraceEvents) Snapshot() TraceSnapshot {
	e.mu.Lock()
	defer e.mu.Unlock()
	return TraceSnapshot{
		Connections:   append([]httptrace.GotConnInfo(nil), e.connections...),
		ConnectStarts: e.connectStarts,
		ConnectDones:  e.connectDones,
	}
}

func NewTeachingServer(handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              "127.0.0.1:0",
		Handler:           handler,
		ReadHeaderTimeout: 2 * time.Second,
		ReadTimeout:       5 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
}
