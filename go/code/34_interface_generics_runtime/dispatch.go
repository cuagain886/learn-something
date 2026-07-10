package main

import (
	"errors"
	"fmt"
	"reflect"
)

var ErrNotSignedSequence = errors.New("value is not a signed integer sequence")

type Signed interface {
	~int | ~int8 | ~int16 | ~int32 | ~int64
}

func SumConcrete(values []int) int {
	total := 0
	for _, v := range values {
		total += v
	}
	return total
}
func SumGeneric[T Signed](values []T) T {
	var total T
	for _, v := range values {
		total += v
	}
	return total
}

type IntSummer interface{ Sum() int }
type IntValues []int

func (v IntValues) Sum() int               { return SumConcrete(v) }
func SumViaInterface(values IntSummer) int { return values.Sum() }
func SumViaReflect(input any) (int64, error) {
	value := reflect.ValueOf(input)
	if !value.IsValid() || (value.Kind() != reflect.Slice && value.Kind() != reflect.Array) {
		return 0, ErrNotSignedSequence
	}
	kind := value.Type().Elem().Kind()
	if kind < reflect.Int || kind > reflect.Int64 {
		return 0, fmt.Errorf("%w: element kind %s", ErrNotSignedSequence, kind)
	}
	var total int64
	for i := 0; i < value.Len(); i++ {
		total += value.Index(i).Int()
	}
	return total, nil
}
func IsTypedNil(input any) bool {
	if input == nil {
		return true
	}
	value := reflect.ValueOf(input)
	switch value.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return value.IsNil()
	default:
		return false
	}
}

//go:noinline
func CallConcrete(v []int) int { return SumConcrete(v) }

//go:noinline
func CallGeneric(v []int) int { return SumGeneric(v) }

//go:noinline
func CallInterface(v IntSummer) int { return SumViaInterface(v) }

//go:noinline
func CallReflect(v any) int64 { n, _ := SumViaReflect(v); return n }
