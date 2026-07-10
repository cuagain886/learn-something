/*
35_syscall_cgo_netpoll —— syscall、epoll/IOCP/kqueue、runtime netpoll 与 cgo

【运行】

	go run ./35_syscall_cgo_netpoll -mode=loopback
	go run ./35_syscall_cgo_netpoll -mode=platform
	go test -race ./35_syscall_cgo_netpoll
*/
package main

import (
	"bytes"
	"context"
	"flag"
	"fmt"
	"os"
)

func main() {
	mode := flag.String("mode", "loopback", "loopback|platform|cgo")
	size := flag.Int("payload-size", 1024, "loopback payload bytes")
	flag.Parse()
	if *size < 0 {
		fmt.Fprintln(os.Stderr, "payload-size must be non-negative")
		return
	}
	switch *mode {
	case "loopback":
		response, err := LoopbackRoundTrip(context.Background(), bytes.Repeat([]byte{'G'}, *size))
		fmt.Printf("bytes=%d err=%v\n", len(response), err)
	case "platform":
		count, err := RunPlatformPoll(context.Background())
		fmt.Printf("poller=%s events=%d err=%v\n", PlatformPoller(), count, err)
	case "cgo":
		value, err := CGOAdd(2, 3)
		fmt.Printf("cgo-add=%d err=%v\n", value, err)
	default:
		fmt.Fprintf(os.Stderr, "unknown mode %q\n", *mode)
	}
}
