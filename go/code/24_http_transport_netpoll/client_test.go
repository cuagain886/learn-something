package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestClientReusesConnectionAfterBodyIsConsumedAndClosed(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "reusable response")
	}))
	defer server.Close()

	client, err := NewClient(ClientConfig{
		RequestTimeout:        time.Second,
		DialTimeout:           time.Second,
		TLSHandshakeTimeout:   time.Second,
		ResponseHeaderTimeout: time.Second,
		IdleConnTimeout:       time.Second,
		MaxIdleConns:          4,
		MaxIdleConnsPerHost:   2,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer client.CloseIdleConnections()

	firstTrace := &TraceEvents{}
	doRequestAndDrain(t, client, WithTrace(context.Background(), firstTrace), server.URL)
	first := firstTrace.Snapshot()
	if len(first.Connections) != 1 || first.Connections[0].Reused {
		t.Fatalf("first connection trace = %+v, want one new connection", first.Connections)
	}

	secondTrace := &TraceEvents{}
	doRequestAndDrain(t, client, WithTrace(context.Background(), secondTrace), server.URL)
	second := secondTrace.Snapshot()
	if len(second.Connections) != 1 || !second.Connections[0].Reused {
		t.Fatalf("second connection trace = %+v, want one reused connection", second.Connections)
	}
}

func doRequestAndDrain(t *testing.T, client *http.Client, ctx context.Context, url string) {
	t.Helper()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(io.Discard, response.Body); err != nil {
		response.Body.Close()
		t.Fatal(err)
	}
	if err := response.Body.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestNewClientRejectsNegativeConfiguration(t *testing.T) {
	tests := []ClientConfig{
		{RequestTimeout: -1},
		{DialTimeout: -1},
		{TLSHandshakeTimeout: -1},
		{ResponseHeaderTimeout: -1},
		{IdleConnTimeout: -1},
		{MaxIdleConns: -1},
		{MaxIdleConnsPerHost: -1},
	}
	for index, config := range tests {
		if _, err := NewClient(config); !errors.Is(err, ErrInvalidClientConfig) {
			t.Fatalf("case %d: NewClient() = %v, want ErrInvalidClientConfig", index, err)
		}
	}
}

func TestClientRequestTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		<-request.Context().Done()
	}))
	defer server.Close()

	client, err := NewClient(ClientConfig{RequestTimeout: 20 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Get(server.URL)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Get() error = %v, want context.DeadlineExceeded", err)
	}
}

func TestClientResponseHeaderTimeout(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		<-release
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(func() {
		close(release)
		server.Close()
	})

	client, err := NewClient(ClientConfig{
		RequestTimeout:        time.Second,
		ResponseHeaderTimeout: 20 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Get(server.URL)
	if err == nil {
		t.Fatal("Get() error = nil, want response header timeout")
	}
	var netErr interface{ Timeout() bool }
	if !errors.As(err, &netErr) || !netErr.Timeout() {
		t.Fatalf("Get() error = %T %v, want timeout error", err, err)
	}
}

func TestClientHonorsRequestCancellation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		<-request.Context().Done()
	}))
	defer server.Close()

	client, err := NewClient(ClientConfig{RequestTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Do(request)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Do() error = %v, want context.Canceled", err)
	}
}

func TestNewTeachingServerConfiguresTimeouts(t *testing.T) {
	server := NewTeachingServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	if server.ReadHeaderTimeout <= 0 || server.ReadTimeout <= 0 || server.WriteTimeout <= 0 || server.IdleTimeout <= 0 {
		t.Fatalf("server timeouts = read-header:%v read:%v write:%v idle:%v, want all positive",
			server.ReadHeaderTimeout, server.ReadTimeout, server.WriteTimeout, server.IdleTimeout)
	}
}

func TestServerShutdownWaitsForInflightRequest(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	server := NewTeachingServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(started)
		<-release
		_, _ = io.WriteString(w, "done")
	}))
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	serveErr := make(chan error, 1)
	go func() { serveErr <- server.Serve(listener) }()

	requestDone := make(chan error, 1)
	go func() {
		client := &http.Client{Timeout: time.Second}
		response, err := client.Get("http://" + listener.Addr().String())
		if err == nil {
			_, err = io.Copy(io.Discard, response.Body)
			closeErr := response.Body.Close()
			if err == nil {
				err = closeErr
			}
		}
		requestDone <- err
	}()
	<-started

	shutdownDone := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		shutdownDone <- server.Shutdown(ctx)
	}()
	select {
	case err := <-shutdownDone:
		t.Fatalf("Shutdown returned before in-flight request finished: %v", err)
	case <-time.After(20 * time.Millisecond):
	}

	close(release)
	if err := <-requestDone; err != nil {
		t.Fatal(err)
	}
	if err := <-shutdownDone; err != nil {
		t.Fatal(err)
	}
	if err := <-serveErr; !errors.Is(err, http.ErrServerClosed) {
		t.Fatalf("Serve() = %v, want http.ErrServerClosed", err)
	}
}
