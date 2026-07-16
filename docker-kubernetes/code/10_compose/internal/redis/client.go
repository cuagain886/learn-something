package redis

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"time"
)

type Client struct {
	Addr    string
	Timeout time.Duration
}

func (c Client) Ping(ctx context.Context) error {
	value, err := c.command(ctx, "PING")
	if err != nil {
		return err
	}
	if value != "PONG" {
		return fmt.Errorf("PING response = %v, want PONG", value)
	}
	return nil
}

func (c Client) Incr(ctx context.Context, key string) (int64, error) {
	value, err := c.command(ctx, "INCR", key)
	if err != nil {
		return 0, err
	}
	integer, ok := value.(int64)
	if !ok {
		return 0, fmt.Errorf("INCR response type = %T, want integer", value)
	}
	return integer, nil
}

func (c Client) command(ctx context.Context, args ...string) (any, error) {
	timeout := c.Timeout
	if timeout <= 0 {
		timeout = time.Second
	}

	dialer := net.Dialer{Timeout: timeout}
	conn, err := dialer.DialContext(ctx, "tcp", c.Addr)
	if err != nil {
		return nil, fmt.Errorf("dial redis %s: %w", c.Addr, err)
	}
	defer conn.Close()

	deadline := time.Now().Add(timeout)
	if contextDeadline, ok := ctx.Deadline(); ok && contextDeadline.Before(deadline) {
		deadline = contextDeadline
	}
	if err := conn.SetDeadline(deadline); err != nil {
		return nil, fmt.Errorf("set redis deadline: %w", err)
	}

	writer := bufio.NewWriter(conn)
	if err := writeCommand(writer, args...); err != nil {
		return nil, err
	}
	if err := writer.Flush(); err != nil {
		return nil, fmt.Errorf("flush redis command: %w", err)
	}
	return readResponse(bufio.NewReader(conn))
}

func writeCommand(w io.Writer, args ...string) error {
	if len(args) == 0 {
		return errors.New("redis command requires at least one argument")
	}
	if _, err := fmt.Fprintf(w, "*%d\r\n", len(args)); err != nil {
		return err
	}
	for _, arg := range args {
		if _, err := fmt.Fprintf(w, "$%d\r\n%s\r\n", len(arg), arg); err != nil {
			return err
		}
	}
	return nil
}

func readResponse(r *bufio.Reader) (any, error) {
	prefix, err := r.ReadByte()
	if err != nil {
		return nil, fmt.Errorf("read redis response prefix: %w", err)
	}
	line, err := readLine(r)
	if err != nil {
		return nil, err
	}

	switch prefix {
	case '+':
		return line, nil
	case '-':
		return nil, fmt.Errorf("redis error: %s", line)
	case ':':
		value, err := strconv.ParseInt(line, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("parse redis integer %q: %w", line, err)
		}
		return value, nil
	case '$':
		length, err := strconv.Atoi(line)
		if err != nil {
			return nil, fmt.Errorf("parse redis bulk length %q: %w", line, err)
		}
		if length == -1 {
			return nil, nil
		}
		if length < -1 || length > 1<<20 {
			return nil, fmt.Errorf("invalid redis bulk length %d", length)
		}
		payload := make([]byte, length+2)
		if _, err := io.ReadFull(r, payload); err != nil {
			return nil, fmt.Errorf("read redis bulk payload: %w", err)
		}
		if string(payload[length:]) != "\r\n" {
			return nil, errors.New("redis bulk payload missing CRLF")
		}
		return string(payload[:length]), nil
	default:
		return nil, fmt.Errorf("unsupported redis response prefix %q", prefix)
	}
}

func readLine(r *bufio.Reader) (string, error) {
	line, err := r.ReadString('\n')
	if err != nil {
		return "", fmt.Errorf("read redis response line: %w", err)
	}
	if !strings.HasSuffix(line, "\r\n") {
		return "", errors.New("redis response line missing CRLF")
	}
	return strings.TrimSuffix(line, "\r\n"), nil
}
