package redis

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

func TestWriteCommandUsesRESPArray(t *testing.T) {
	var output bytes.Buffer
	if err := writeCommand(&output, "INCR", "page_hits"); err != nil {
		t.Fatal(err)
	}
	want := "*2\r\n$4\r\nINCR\r\n$9\r\npage_hits\r\n"
	if output.String() != want {
		t.Fatalf("command = %q, want %q", output.String(), want)
	}
}

func TestReadResponse(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    any
		wantErr bool
	}{
		{name: "simple string", input: "+PONG\r\n", want: "PONG"},
		{name: "integer", input: ":42\r\n", want: int64(42)},
		{name: "bulk", input: "$5\r\nhello\r\n", want: "hello"},
		{name: "null bulk", input: "$-1\r\n", want: nil},
		{name: "server error", input: "-ERR wrong type\r\n", wantErr: true},
		{name: "invalid framing", input: "+PONG\n", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := readResponse(bufio.NewReader(strings.NewReader(tt.input)))
			if tt.wantErr {
				if err == nil {
					t.Fatalf("readResponse() = %v, want error", got)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got != tt.want {
				t.Fatalf("readResponse() = %#v, want %#v", got, tt.want)
			}
		})
	}
}

func TestClientIncrOverTCP(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	serverErr := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			serverErr <- err
			return
		}
		defer conn.Close()

		want := "*2\r\n$4\r\nINCR\r\n$9\r\npage_hits\r\n"
		request := make([]byte, len(want))
		if _, err := io.ReadFull(conn, request); err != nil {
			serverErr <- err
			return
		}
		if string(request) != want {
			serverErr <- &protocolMismatch{got: string(request), want: want}
			return
		}
		_, err = io.WriteString(conn, ":9\r\n")
		serverErr <- err
	}()

	client := Client{Addr: listener.Addr().String(), Timeout: time.Second}
	got, err := client.Incr(context.Background(), "page_hits")
	if err != nil {
		t.Fatal(err)
	}
	if got != 9 {
		t.Fatalf("Incr() = %d, want 9", got)
	}
	if err := <-serverErr; err != nil {
		t.Fatal(err)
	}
}

type protocolMismatch struct {
	got  string
	want string
}

func (e *protocolMismatch) Error() string {
	return "request = " + e.got + ", want " + e.want
}
