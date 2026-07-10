package main

import (
	"errors"
	"fmt"
)

const (
	groupSlots  = 8
	ctrlEmpty   = uint8(0x80)
	ctrlDeleted = uint8(0xfe)
	maxLoad     = 7
)

var ErrInvalidTable = errors.New("invalid Swiss Table teaching model")

type Hasher[K comparable] func(K) uint64
type entry[K comparable, V any] struct {
	key   K
	value V
}
type Table[K comparable, V any] struct {
	ctrls        []uint8
	slots        []entry[K, V]
	length, dead int
	hash         Hasher[K]
}

func NewTable[K comparable, V any](capacity int, hasher Hasher[K]) (*Table[K, V], error) {
	if capacity < 0 || hasher == nil {
		return nil, fmt.Errorf("%w: capacity must be non-negative and hasher non-nil", ErrInvalidTable)
	}
	size := groupSlots
	for size < capacity {
		size *= 2
	}
	t := &Table[K, V]{ctrls: make([]uint8, size), slots: make([]entry[K, V], size), hash: hasher}
	for i := range t.ctrls {
		t.ctrls[i] = ctrlEmpty
	}
	return t, nil
}

func (t *Table[K, V]) Len() int      { return t.length }
func (t *Table[K, V]) Capacity() int { return len(t.ctrls) }

func (t *Table[K, V]) Set(key K, value V) {
	if index, found, _ := t.find(key); found {
		t.slots[index].value = value
		return
	}
	if (t.length+t.dead+1)*groupSlots > len(t.ctrls)*maxLoad {
		t.grow()
	}
	_, _, index := t.find(key)
	if t.ctrls[index] == ctrlDeleted {
		t.dead--
	}
	t.ctrls[index] = fingerprint(t.hash(key))
	t.slots[index] = entry[K, V]{key: key, value: value}
	t.length++
}

func (t *Table[K, V]) Get(key K) (V, bool) {
	index, found, _ := t.find(key)
	if found {
		return t.slots[index].value, true
	}
	var zero V
	return zero, false
}

func (t *Table[K, V]) Delete(key K) bool {
	index, found, _ := t.find(key)
	if !found {
		return false
	}
	var zero entry[K, V]
	t.slots[index] = zero
	t.ctrls[index] = ctrlDeleted
	t.length--
	t.dead++
	if t.length == 0 {
		for i := range t.ctrls {
			t.ctrls[i] = ctrlEmpty
		}
		t.dead = 0
	}
	return true
}

func (t *Table[K, V]) find(key K) (int, bool, int) {
	hash := t.hash(key)
	want := fingerprint(hash)
	mask := len(t.ctrls) - 1
	start := int((hash >> 7) & uint64(mask))
	firstDead := -1
	for offset := 0; offset < len(t.ctrls); offset++ {
		index := (start + offset) & mask
		switch t.ctrls[index] {
		case ctrlEmpty:
			if firstDead >= 0 {
				return -1, false, firstDead
			}
			return -1, false, index
		case ctrlDeleted:
			if firstDead < 0 {
				firstDead = index
			}
		default:
			if t.ctrls[index] == want && t.slots[index].key == key {
				return index, true, index
			}
		}
	}
	return -1, false, firstDead
}

func (t *Table[K, V]) grow() {
	oldCtrls, oldSlots := t.ctrls, t.slots
	t.ctrls = make([]uint8, len(oldCtrls)*2)
	t.slots = make([]entry[K, V], len(oldSlots)*2)
	for i := range t.ctrls {
		t.ctrls[i] = ctrlEmpty
	}
	t.length, t.dead = 0, 0
	for i, ctrl := range oldCtrls {
		if ctrl < ctrlEmpty {
			t.Set(oldSlots[i].key, oldSlots[i].value)
		}
	}
}

func fingerprint(hash uint64) uint8 { return uint8(hash & 0x7f) }
func HashInt(value int) uint64 {
	x := uint64(int64(value)) + 0x9e3779b97f4a7c15
	x = (x ^ (x >> 30)) * 0xbf58476d1ce4e5b9
	x = (x ^ (x >> 27)) * 0x94d049bb133111eb
	return x ^ (x >> 31)
}
func HashString(value string) uint64 {
	h := uint64(14695981039346656037)
	for i := 0; i < len(value); i++ {
		h ^= uint64(value[i])
		h *= 1099511628211
	}
	return h
}
