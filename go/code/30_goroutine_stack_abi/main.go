/*
30_goroutine_stack_abi —— 连续栈、调用帧、寄存器 ABI 与 panic 展开

【运行】

	go run ./30_goroutine_stack_abi -depth=128
	go test -race ./30_goroutine_stack_abi
	go test ./30_goroutine_stack_abi -run '^$' -bench '.' -benchmem
	go build -gcflags='-m=2' ./30_goroutine_stack_abi
*/
package main

import (
	"bytes"
	"flag"
	"fmt"
	"os"
)

func main() {
	depth := flag.Int("depth", 128, "safe teaching recursion depth")
	flag.Parse()

	recursive, err := RecursiveSum(*depth)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return
	}
	iterative, _ := IterativeSum(*depth)
	stack, err := CaptureStackAtDepth(*depth)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return
	}
	counter := MakeCounter(40)
	fmt.Printf("depth=%d recursive=%d iterative=%d stack-lines=%d\n", *depth, recursive, iterative, bytes.Count(stack, []byte{'\n'}))
	fmt.Printf("closure=%d,%d recovered=%v abi-sum=%d\n", counter(), counter(), InvokeWithRecovery(func() { panic("demo") }), CallAddSix())
	fmt.Println("用 go tool objdump 观察 CallAddSix；汇编和寄存器属于版本/架构实现。")
}
