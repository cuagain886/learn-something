//go:build linux

package main

import (
	"context"
	"errors"
	"syscall"
)

func PlatformPoller() string { return "epoll" }

func RunPlatformPoll(ctx context.Context) (int, error) {
	fds := [2]int{}
	if err := syscall.Pipe(fds[:]); err != nil {
		return 0, err
	}
	defer syscall.Close(fds[0])
	defer syscall.Close(fds[1])
	if err := syscall.SetNonblock(fds[0], true); err != nil {
		return 0, err
	}
	epoll, err := syscall.EpollCreate1(0)
	if err != nil {
		return 0, err
	}
	defer syscall.Close(epoll)
	if err := syscall.EpollCtl(epoll, syscall.EPOLL_CTL_ADD, fds[0], &syscall.EpollEvent{Events: syscall.EPOLLIN, Fd: int32(fds[0])}); err != nil {
		return 0, err
	}
	writeResult := make(chan error, 1)
	go func() {
		_, writeErr := syscall.Write(fds[1], []byte{1})
		writeResult <- writeErr
	}()
	events := make([]syscall.EpollEvent, 1)
	for {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		count, waitErr := syscall.EpollWait(epoll, events, 50)
		if waitErr != nil && !errors.Is(waitErr, syscall.EINTR) {
			return 0, waitErr
		}
		if count > 0 {
			buffer := [1]byte{}
			_, _ = syscall.Read(fds[0], buffer[:])
			if writeErr := <-writeResult; writeErr != nil {
				return 0, writeErr
			}
			return count, nil
		}
	}
}
