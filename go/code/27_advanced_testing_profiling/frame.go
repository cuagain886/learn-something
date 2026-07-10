package main

import (
	"encoding/binary"
	"errors"
	"hash/crc32"
	"math"
)

const (
	frameHeaderSize   = 4
	frameChecksumSize = 4
	minimumFrameSize  = frameHeaderSize + frameChecksumSize
)

var (
	ErrShortFrame      = errors.New("frame is shorter than the fixed header and checksum")
	ErrLengthMismatch  = errors.New("frame payload length does not match encoded size")
	ErrChecksum        = errors.New("frame checksum mismatch")
	ErrPayloadTooLarge = errors.New("frame payload exceeds uint16 length")
)

type Frame struct {
	Version uint8
	Flags   uint8
	Payload []byte
}

func Encode(frame Frame) ([]byte, error) {
	if len(frame.Payload) > math.MaxUint16 {
		return nil, ErrPayloadTooLarge
	}
	encoded := make([]byte, minimumFrameSize+len(frame.Payload))
	encoded[0] = frame.Version
	encoded[1] = frame.Flags
	binary.BigEndian.PutUint16(encoded[2:4], uint16(len(frame.Payload)))
	copy(encoded[frameHeaderSize:], frame.Payload)
	checksumOffset := frameHeaderSize + len(frame.Payload)
	binary.BigEndian.PutUint32(encoded[checksumOffset:], crc32.ChecksumIEEE(encoded[:checksumOffset]))
	return encoded, nil
}

func Decode(encoded []byte) (Frame, error) {
	if len(encoded) < minimumFrameSize {
		return Frame{}, ErrShortFrame
	}
	payloadLength := int(binary.BigEndian.Uint16(encoded[2:4]))
	expectedLength := minimumFrameSize + payloadLength
	if len(encoded) != expectedLength {
		return Frame{}, ErrLengthMismatch
	}
	checksumOffset := frameHeaderSize + payloadLength
	wantChecksum := binary.BigEndian.Uint32(encoded[checksumOffset:])
	if gotChecksum := crc32.ChecksumIEEE(encoded[:checksumOffset]); gotChecksum != wantChecksum {
		return Frame{}, ErrChecksum
	}
	payload := append([]byte(nil), encoded[frameHeaderSize:checksumOffset]...)
	return Frame{Version: encoded[0], Flags: encoded[1], Payload: payload}, nil
}
