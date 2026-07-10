//go:build cgo && cgo_lab

package main

/*
static int add_ints(int a, int b) { return a + b; }
*/
import "C"

func CGOAdd(a, b int) (int, error) {
	return int(C.add_ints(C.int(a), C.int(b))), nil
}
