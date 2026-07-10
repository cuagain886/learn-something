package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"testing"
	"testing/quick"
	"time"
)

func TestFrameRoundTrip(t *testing.T) {
	want := Frame{Version: 1, Flags: 2, Payload: []byte("Go frame")}
	encoded, err := Encode(want)
	if err != nil {
		t.Fatal(err)
	}
	got, err := Decode(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if got.Version != want.Version || got.Flags != want.Flags || !bytes.Equal(got.Payload, want.Payload) {
		t.Fatalf("Decode(Encode()) = %+v, want %+v", got, want)
	}

	encoded[4] = 'X'
	if string(got.Payload) != "Go frame" {
		t.Fatalf("decoded payload aliases encoded bytes: %q", got.Payload)
	}
}

func TestDecodeClassifiesMalformedFrames(t *testing.T) {
	valid, err := Encode(Frame{Version: 1, Payload: []byte("ok")})
	if err != nil {
		t.Fatal(err)
	}

	lengthMismatch := append([]byte(nil), valid...)
	lengthMismatch[2], lengthMismatch[3] = 0, 3
	badChecksum := append([]byte(nil), valid...)
	badChecksum[4] ^= 0xff

	tests := []struct {
		name  string
		input []byte
		want  error
	}{
		{"short", []byte{1, 2, 3}, ErrShortFrame},
		{"length mismatch", lengthMismatch, ErrLengthMismatch},
		{"checksum", badChecksum, ErrChecksum},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := Decode(tt.input); !errors.Is(err, tt.want) {
				t.Fatalf("Decode() = %v, want %v", err, tt.want)
			}
		})
	}
}

func TestEncodeRejectsOversizedPayload(t *testing.T) {
	payload := make([]byte, math.MaxUint16+1)
	if _, err := Encode(Frame{Payload: payload}); !errors.Is(err, ErrPayloadTooLarge) {
		t.Fatalf("Encode() = %v, want ErrPayloadTooLarge", err)
	}
}

func TestFrameRoundTripProperty(t *testing.T) {
	property := func(version, flags uint8, payload []byte) bool {
		if len(payload) > math.MaxUint16 {
			return true
		}
		encoded, err := Encode(Frame{Version: version, Flags: flags, Payload: payload})
		if err != nil {
			return false
		}
		decoded, err := Decode(encoded)
		return err == nil && decoded.Version == version && decoded.Flags == flags && bytes.Equal(decoded.Payload, payload)
	}
	if err := quick.Check(property, &quick.Config{MaxCount: 500}); err != nil {
		t.Fatal(err)
	}
}

func TestFrameCasesInParallel(t *testing.T) {
	for _, size := range []int{0, 1, 32, 1024} {
		size := size
		t.Run(fmt.Sprintf("payload-%d", size), func(t *testing.T) {
			t.Parallel()
			payload := bytes.Repeat([]byte{byte(size)}, size)
			encoded, err := Encode(Frame{Version: 1, Payload: payload})
			if err != nil {
				t.Fatal(err)
			}
			decoded, err := Decode(encoded)
			if err != nil || !bytes.Equal(decoded.Payload, payload) {
				t.Fatalf("Decode() = %+v, %v", decoded, err)
			}
		})
	}
}

func TestFrameGolden(t *testing.T) {
	encoded, err := Encode(Frame{Version: 1, Flags: 2, Payload: []byte("Go")})
	if err != nil {
		t.Fatal(err)
	}
	want, err := os.ReadFile("testdata/frame.golden")
	if err != nil {
		t.Fatal(err)
	}
	got := fmt.Sprintf("%x\n", encoded)
	if got != string(want) {
		t.Fatalf("golden mismatch\n got: %s want: %s", got, want)
	}
}

func TestRunWorkloadSupportsProfileModes(t *testing.T) {
	for _, mode := range []string{"cpu", "alloc", "mutex", "block", "trace"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Millisecond)
			defer cancel()
			if err := runWorkload(ctx, mode); err != nil {
				t.Fatalf("runWorkload(%q) = %v", mode, err)
			}
		})
	}
}

func TestRunWorkloadRejectsUnknownMode(t *testing.T) {
	if err := runWorkload(context.Background(), "mystery"); !errors.Is(err, ErrUnknownMode) {
		t.Fatalf("runWorkload(mystery) = %v, want ErrUnknownMode", err)
	}
}
