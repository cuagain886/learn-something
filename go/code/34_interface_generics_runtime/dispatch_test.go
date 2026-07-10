package main

import (
	"errors"
	"testing"
)

func TestSumPathsAgree(t *testing.T) {
	values := []int{1, 2, 3, 4}
	if SumConcrete(values) != 10 || SumGeneric(values) != 10 || SumViaInterface(IntValues(values)) != 10 {
		t.Fatal("sum mismatch")
	}
	got, err := SumViaReflect(values)
	if err != nil || got != 10 {
		t.Fatalf("reflect=%d err=%v", got, err)
	}
}
func TestTypedNil(t *testing.T) {
	var pointer *int
	if !IsTypedNil(pointer) || !IsTypedNil(nil) || IsTypedNil(0) {
		t.Fatal("typed nil classification failed")
	}
}
func TestSumViaReflectRejectsUnsigned(t *testing.T) {
	if _, err := SumViaReflect([]uint{1}); !errors.Is(err, ErrNotSignedSequence) {
		t.Fatalf("error=%v", err)
	}
}
