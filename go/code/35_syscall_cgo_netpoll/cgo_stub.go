//go:build !cgo || !cgo_lab

package main

func CGOAdd(a, b int) (int, error) {
	return 0, ErrCGOLabDisabled
}
