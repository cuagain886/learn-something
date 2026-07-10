package main

import "unsafe"

type Layout struct {
	Size  uintptr
	Align uintptr
}

func LayoutOf[T any]() Layout {
	var value T
	return Layout{
		Size:  unsafe.Sizeof(value),
		Align: unsafe.Alignof(value),
	}
}

// SafeBytesToString 创建字符串副本；返回后调用者可以继续修改 source。
func SafeBytesToString(source []byte) string {
	return string(source)
}

// UnsafeBytesToReadOnlyString 返回与 source 共享内存的只读字符串视图。
// 在字符串仍被使用期间，source 必须保持存活且绝不能被修改。
// 除非 Benchmark 证明复制是热点且所有权能够被严格证明，否则不要使用。
func UnsafeBytesToReadOnlyString(source []byte) string {
	if len(source) == 0 {
		return ""
	}
	return unsafe.String(unsafe.SliceData(source), len(source))
}
