//go:build !linux

package main

import (
	"context"
	"fmt"
	"runtime"
)

func PlatformPoller() string {
	switch runtime.GOOS {
	case "windows":
		return "iocp"
	case "darwin", "freebsd", "openbsd", "netbsd", "dragonfly":
		return "kqueue"
	default:
		return "unsupported"
	}
}

func RunPlatformPoll(context.Context) (int, error) {
	return 0, fmt.Errorf("%w: raw teaching experiment requires linux epoll", ErrUnsupported)
}
