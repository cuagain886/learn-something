//go:build cgo && cgo_lab

package main

import "testing"

func TestCGOAddWithLabEnabled(t *testing.T) {
	got, err := CGOAdd(2, 3)
	if err != nil || got != 5 {
		t.Fatalf("CGOAdd()=%d,%v", got, err)
	}
}
