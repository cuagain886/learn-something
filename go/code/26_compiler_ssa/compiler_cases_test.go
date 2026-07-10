package main

import "testing"

func TestSumImplementationsAreEquivalent(t *testing.T) {
	tests := [][]int{
		nil,
		{},
		{42},
		{1, 2, 3, 4, 5},
		{-5, 10, -2},
	}
	for _, values := range tests {
		checked := SumChecked(values)
		if got := SumBCE(values); got != checked {
			t.Fatalf("SumBCE(%v) = %d, want %d", values, got, checked)
		}
		if got := GenericSum(values); got != checked {
			t.Fatalf("GenericSum(%v) = %d, want %d", values, got, checked)
		}
		if got := InterfaceSum(IntSlice(values)); got != checked {
			t.Fatalf("InterfaceSum(%v) = %d, want %d", values, got, checked)
		}
	}
}

func TestInlineAndEscapeExamplesPreserveValues(t *testing.T) {
	if got := InlineAdd(20, 22); got != 42 {
		t.Fatalf("InlineAdd() = %d, want 42", got)
	}
	if got := NoInlineAdd(20, 22); got != 42 {
		t.Fatalf("NoInlineAdd() = %d, want 42", got)
	}
	if got := StackValue(); got != 42 {
		t.Fatalf("StackValue() = %d, want 42", got)
	}
	if got := *EscapingValue(); got != 42 {
		t.Fatalf("*EscapingValue() = %d, want 42", got)
	}
}
