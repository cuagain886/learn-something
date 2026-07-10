/*
24_http_transport_netpoll —— HTTP 连接池、超时、netpoll 与优雅停机

【本节学什么】
 1. http.Client 与 Transport 的职责，以及为什么必须复用它们
 2. 完整读取并关闭 Body 如何让连接回到 idle pool
 3. 请求总超时、建连、TLS、响应头和空闲连接超时的边界
 4. runtime netpoll 如何把 OS 网络事件交回 Go 调度器

【运行】

	go run ./24_http_transport_netpoll
	go test -race ./24_http_transport_netpoll
	go test -run='^$' -bench=. -benchmem ./24_http_transport_netpoll
*/
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"time"
)

func main() {
	fmt.Println("══════ 1. 连接复用 ══════")
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "ok")
	}))
	defer backend.Close()

	client, _ := NewClient(ClientConfig{
		RequestTimeout:        time.Second,
		DialTimeout:           time.Second,
		TLSHandshakeTimeout:   time.Second,
		ResponseHeaderTimeout: time.Second,
		IdleConnTimeout:       30 * time.Second,
		MaxIdleConns:          10,
		MaxIdleConnsPerHost:   2,
	})
	defer client.CloseIdleConnections()
	for number := 1; number <= 2; number++ {
		events := &TraceEvents{}
		request, _ := http.NewRequestWithContext(WithTrace(context.Background(), events), http.MethodGet, backend.URL, nil)
		response, err := client.Do(request)
		if err != nil {
			fmt.Println("request error:", err)
			continue
		}
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
		trace := events.Snapshot()
		fmt.Printf("request-%d reused=%v connect-starts=%d\n", number, trace.Connections[0].Reused, trace.ConnectStarts)
	}

	fmt.Println("\n══════ 2. 请求总超时 ══════")
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		<-request.Context().Done()
	}))
	timeoutClient, _ := NewClient(ClientConfig{RequestTimeout: 30 * time.Millisecond})
	_, err := timeoutClient.Get(slow.URL)
	fmt.Println("deadline exceeded:", errors.Is(err, context.DeadlineExceeded))
	slow.Close()

	fmt.Println("\n══════ 3. 服务端超时与优雅停机 ══════")
	server := NewTeachingServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	fmt.Printf("ReadHeader=%v Read=%v Write=%v Idle=%v\n",
		server.ReadHeaderTimeout, server.ReadTimeout, server.WriteTimeout, server.IdleTimeout)
	fmt.Println("Server.Shutdown 会停止接收新连接并等待在途请求；完整实验见单元测试。")

	fmt.Println("\n══════ 4. netpoll 平台实现 ══════")
	fmt.Println("Windows=IOCP，Linux=epoll，BSD/macOS=kqueue；共同目标是唤醒可继续运行的 goroutine。")
}
