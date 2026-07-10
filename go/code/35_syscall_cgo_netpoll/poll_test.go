package main

import (
	"bytes"
	"context"
	"errors"
	"testing"
)

type oneByteWriter struct{ bytes.Buffer }

func (writer *oneByteWriter) Write(data []byte) (int, error) { return writer.Buffer.Write(data[:1]) }

func TestWriteFrameHandlesShortWrites(t *testing.T) {
	writer := &oneByteWriter{}
	if err := writeFrame(writer, []byte("abc")); err != nil {
		t.Fatal(err)
	}
	if writer.Len() != 7 {
		t.Fatalf("encoded bytes=%d, want 7", writer.Len())
	}
}

func TestLoopbackRoundTrip(t *testing.T) {
	want := []byte("netpoll")
	got, err := LoopbackRoundTrip(context.Background(), want)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("got=%q", got)
	}
	want[0] = 'X'
	if string(got) != "netpoll" {
		t.Fatal("response aliases input")
	}
}
func TestLoopbackObservesCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := LoopbackRoundTrip(ctx, []byte("x")); !errors.Is(err, context.Canceled) {
		t.Fatalf("error=%v", err)
	}
}
func TestCGOAddIsExplicit(t *testing.T) {
	got, err := CGOAdd(2, 3)
	if errors.Is(err, ErrCGOLabDisabled) {
		return
	}
	if err != nil || got != 5 {
		t.Fatalf("got=%d err=%v", got, err)
	}
}

func TestLoopbackRejectsOversizedPayload(t *testing.T) {
	_, err := LoopbackRoundTrip(context.Background(), make([]byte, maxLoopbackPayload+1))
	if !errors.Is(err, ErrPayloadTooLarge) {
		t.Fatalf("error=%v, want ErrPayloadTooLarge", err)
	}
}
