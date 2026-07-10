package main

import (
	"bytes"
	"errors"
	"math"
	"testing"
)

func FuzzFrameRoundTrip(f *testing.F) {
	f.Add(uint8(1), uint8(0), []byte("seed"))
	f.Add(uint8(255), uint8(255), []byte{})
	f.Fuzz(func(t *testing.T, version, flags uint8, payload []byte) {
		if len(payload) > math.MaxUint16 {
			t.Skip()
		}
		encoded, err := Encode(Frame{Version: version, Flags: flags, Payload: payload})
		if err != nil {
			t.Fatal(err)
		}
		decoded, err := Decode(encoded)
		if err != nil {
			t.Fatal(err)
		}
		if decoded.Version != version || decoded.Flags != flags || !bytes.Equal(decoded.Payload, payload) {
			t.Fatalf("round trip mismatch: got=%+v", decoded)
		}
	})
}

func FuzzDecodeNeverPanics(f *testing.F) {
	valid, err := Encode(Frame{Version: 1, Flags: 2, Payload: []byte("seed")})
	if err != nil {
		f.Fatal(err)
	}
	f.Add(valid)
	f.Add([]byte{})
	f.Add([]byte{1, 2, 3})
	f.Fuzz(func(t *testing.T, encoded []byte) {
		decoded, err := Decode(encoded)
		if err != nil {
			if !errors.Is(err, ErrShortFrame) && !errors.Is(err, ErrLengthMismatch) && !errors.Is(err, ErrChecksum) {
				t.Fatalf("Decode() returned unclassified error: %v", err)
			}
			return
		}
		reencoded, err := Encode(decoded)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(reencoded, encoded) {
			t.Fatalf("successful Decode did not round trip")
		}
	})
}
