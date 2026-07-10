package main

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"time"
)

const maxLoopbackPayload = 1 << 20

var (
	ErrPayloadTooLarge = errors.New("loopback payload exceeds 1 MiB")
	ErrUnsupported     = errors.New("platform poll experiment is unsupported")
	ErrCGOLabDisabled  = errors.New("cgo lab requires CGO_ENABLED=1 and -tags=cgo_lab")
)

func LoopbackRoundTrip(parent context.Context, payload []byte) ([]byte, error) {
	if err := parent.Err(); err != nil {
		return nil, err
	}
	if len(payload) > maxLoopbackPayload {
		return nil, ErrPayloadTooLarge
	}
	ctx, cancel := context.WithTimeout(parent, 2*time.Second)
	defer cancel()

	listener, err := (&net.ListenConfig{}).Listen(ctx, "tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	serverResult := make(chan error, 1)
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			serverResult <- acceptErr
			return
		}
		defer connection.Close()
		if deadline, ok := ctx.Deadline(); ok {
			_ = connection.SetDeadline(deadline)
		}
		frame, readErr := readFrame(connection)
		if readErr == nil {
			readErr = writeFrame(connection, frame)
		}
		serverResult <- readErr
	}()

	connection, dialErr := (&net.Dialer{}).DialContext(ctx, "tcp", listener.Addr().String())
	if dialErr != nil {
		_ = listener.Close()
		<-serverResult
		return nil, dialErr
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = connection.SetDeadline(deadline)
	}
	clientErr := writeFrame(connection, payload)
	var response []byte
	if clientErr == nil {
		response, clientErr = readFrame(connection)
	}
	_ = connection.Close()
	_ = listener.Close()
	serverErr := <-serverResult
	if clientErr != nil {
		return nil, clientErr
	}
	if serverErr != nil {
		return nil, serverErr
	}
	return response, nil
}

func writeFrame(writer io.Writer, payload []byte) error {
	header := [4]byte{}
	binary.BigEndian.PutUint32(header[:], uint32(len(payload)))
	if err := writeFull(writer, header[:]); err != nil {
		return err
	}
	return writeFull(writer, payload)
}

func writeFull(writer io.Writer, data []byte) error {
	for len(data) > 0 {
		written, err := writer.Write(data)
		if err != nil {
			return err
		}
		if written <= 0 || written > len(data) {
			return io.ErrNoProgress
		}
		data = data[written:]
	}
	return nil
}

func readFrame(reader io.Reader) ([]byte, error) {
	header := [4]byte{}
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return nil, err
	}
	length := binary.BigEndian.Uint32(header[:])
	if length > maxLoopbackPayload {
		return nil, fmt.Errorf("%w: peer announced %d bytes", ErrPayloadTooLarge, length)
	}
	payload := make([]byte, int(length))
	_, err := io.ReadFull(reader, payload)
	return payload, err
}
