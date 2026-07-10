package main

import (
	"errors"
	"strconv"
	"testing"
)

func TestTableSetGetDeleteAndGrow(t *testing.T) {
	table, err := NewTable[int, string](1, HashInt)
	if err != nil {
		t.Fatal(err)
	}
	for key := range 200 {
		table.Set(key, strconv.Itoa(key))
	}
	for key := range 200 {
		if got, ok := table.Get(key); !ok || got != strconv.Itoa(key) {
			t.Fatalf("Get(%d)=%q,%v", key, got, ok)
		}
	}
	if !table.Delete(17) {
		t.Fatal("Delete(17)=false")
	}
	if _, ok := table.Get(17); ok || table.Len() != 199 {
		t.Fatalf("deleted key remains, len=%d", table.Len())
	}
}

func TestTableHandlesCollisionsAndOverwrite(t *testing.T) {
	table, _ := NewTable[int, int](0, func(int) uint64 { return 1 })
	for key := range 50 {
		table.Set(key, key)
	}
	table.Set(10, 999)
	if got, ok := table.Get(10); !ok || got != 999 || table.Len() != 50 {
		t.Fatalf("got=%d,%v len=%d", got, ok, table.Len())
	}
	for key := range 50 {
		if got, ok := table.Get(key); !ok || (key != 10 && got != key) {
			t.Fatalf("key=%d got=%d,%v", key, got, ok)
		}
	}
}

func TestNewTableRejectsInvalidArguments(t *testing.T) {
	if _, err := NewTable[int, int](-1, HashInt); !errors.Is(err, ErrInvalidTable) {
		t.Fatalf("error=%v", err)
	}
	if _, err := NewTable[int, int](0, nil); !errors.Is(err, ErrInvalidTable) {
		t.Fatalf("error=%v", err)
	}
}
