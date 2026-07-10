/*
28_production_service —— 生产级并发 HTTP 服务综合实战

【本节学什么】
 1. JSON API、request ID、日志、指标和独立 pprof 端口
 2. 入口 token bucket、有界任务队列、重试与熔断
 3. 任务 timeout、panic 隔离和并发安全状态存储
 4. not-ready → HTTP → queue/worker → debug 的优雅关闭顺序

【运行】

	go run ./28_production_service
	go run ./28_production_service -addr 127.0.0.1:0 -debug-addr 127.0.0.1:0 -run-for 1s
	go test -race ./28_production_service/...

【接口】

	POST /v1/jobs       {"payload":"hello"}
	GET  /v1/jobs/{id}
	GET  debug:/healthz /readyz /metrics /debug/pprof/
*/
package main

import (
	"context"
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"learn_go/28_production_service/internal/app"
	"learn_go/28_production_service/internal/config"
)

func main() {
	cfg := config.Default()
	addr := flag.String("addr", cfg.Addr, "business HTTP listen address")
	debugAddr := flag.String("debug-addr", cfg.DebugAddr, "diagnostic HTTP listen address")
	runFor := flag.Duration("run-for", 0, "optional automatic shutdown duration for smoke tests")
	flag.Parse()
	cfg.Addr = *addr
	cfg.DebugAddr = *debugAddr

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	root, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	if *runFor > 0 {
		var cancel context.CancelFunc
		root, cancel = context.WithTimeout(root, *runFor)
		defer cancel()
	}

	started := time.Now()
	if err := app.Run(root, cfg, logger); err != nil {
		logger.Error("service exited with error", "error", err, "uptime", time.Since(started))
		return
	}
	logger.Info("service exited cleanly", "uptime", time.Since(started))
}
