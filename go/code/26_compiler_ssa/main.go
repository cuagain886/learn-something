/*
26_compiler_ssa —— 编译器、逃逸、内联、BCE、SSA 与汇编

【本节学什么】
 1. 源码经过类型检查、IR、SSA 和机器码的主要阶段
 2. 如何用 -m=2 查看逃逸、内联和去虚拟化决定
 3. 如何用 GOSSAFUNC 与 objdump 观察单个函数
 4. 为什么汇编输出必须和语义测试、Benchmark 一起解读

【运行】

	go run ./26_compiler_ssa
	go test ./26_compiler_ssa
	go test -gcflags='-m=2' ./26_compiler_ssa
	$env:GOSSAFUNC='SumBCE'; go build ./26_compiler_ssa
	go test -run='^$' -bench=. -benchmem ./26_compiler_ssa
*/
package main

import "fmt"

func main() {
	values := []int{1, 2, 3, 4, 5}
	fmt.Println("══════ 1. 语义等价 ══════")
	fmt.Println("checked:", SumChecked(values))
	fmt.Println("BCE:", SumBCE(values))
	fmt.Println("generic:", GenericSum(values))
	fmt.Println("interface:", InterfaceSum(IntSlice(values)))

	fmt.Println("\n══════ 2. 内联对照 ══════")
	fmt.Println("InlineAdd:", InlineAdd(20, 22))
	fmt.Println("NoInlineAdd:", NoInlineAdd(20, 22))

	fmt.Println("\n══════ 3. 逃逸对照 ══════")
	fmt.Println("StackValue:", StackValue())
	fmt.Println("EscapingValue:", *EscapingValue())

	fmt.Println("\n══════ 4. 工具命令 ══════")
	fmt.Println("-gcflags='-m=2' 看编译器决策；GOSSAFUNC=SumBCE 看 SSA；objdump 看最终指令。")
	fmt.Println("输出随 Go 版本、GOOS、GOARCH 变化，不要背固定汇编行号。")
}
