package main

import "testing"

func FuzzSwissTable(f *testing.F) {
	f.Add([]byte{0, 1, 10, 0, 2, 20, 2, 1, 0, 1, 1, 0})
	f.Fuzz(func(t *testing.T, ops []byte) {
		table, _ := NewTable[int, byte](0, HashInt)
		model := map[int]byte{}
		for i := 0; i+2 < len(ops); i += 3 {
			op, key, value := ops[i]%3, int(ops[i+1]), ops[i+2]
			switch op {
			case 0:
				table.Set(key, value)
				model[key] = value
			case 1:
				_, exists := model[key]
				if table.Delete(key) != exists {
					t.Fatalf("Delete(%d) mismatch", key)
				}
				delete(model, key)
			case 2:
				got, ok := table.Get(key)
				want, wok := model[key]
				if ok != wok || got != want {
					t.Fatalf("Get(%d)=%d,%v want %d,%v", key, got, ok, want, wok)
				}
			}
		}
		if table.Len() != len(model) {
			t.Fatalf("Len=%d want %d", table.Len(), len(model))
		}
	})
}
