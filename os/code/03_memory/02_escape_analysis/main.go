// 02_escape_analysis — 六种逃逸场景：预测、验证、实测分配次数
//
// 学什么：
//  1. 六种高频逃逸模式的最小复现（返回指针/interface/闭包/动态大小/过大/进channel）
//  2. 用编译器亲口验证：go build -gcflags='-m' ./03_memory/02_escape_analysis
//     输出里 "escapes to heap" / "moved to heap" 就是判决书
//  3. 用 testing.AllocsPerRun 实测每次调用的堆分配次数——逃逸的代价可测量
//     ⚠️ 记住：结论以 -m 为准且随编译器版本变化，热路径小对象才值得抠
//
// 运行：
//   go build -gcflags='-m' ./03_memory/02_escape_analysis 2>&1 | grep -E 'escape|moved'
//   go run ./03_memory/02_escape_analysis
package main

import (
	"fmt"
	"testing"
)

type User struct{ ID, Age int }

// ① 不逃逸：局部使用，随栈帧蒸发 —— 分配次数应为 0
func noEscape() int {
	u := User{ID: 1, Age: 20} // -m: 不会提它，或提示 does not escape
	return u.ID + u.Age
}

// ② 返回局部变量指针 → 逃逸（调用方还要用，栈帧没了它不能没）
func escapeReturnPtr() *User {
	u := User{ID: 1} // -m: moved to heap: u
	return &u
}

// ③ 存进 interface{} → 逃逸（装箱；fmt 系全家都是这个原因）
var sink interface{}

func escapeInterface() {
	u := User{ID: 2} // -m: u escapes to heap
	sink = u
}

// ④ 被外泄的闭包捕获 → 逃逸（x 的生命周期跟着闭包走了）
func escapeClosure() func() int {
	x := 0 // -m: moved to heap: x
	return func() int { x++; return x }
}

// ⑤ 大小编译期未知 → 逃逸（栈帧大小必须编译期确定）
func escapeDynamicSize(n int) []byte {
	buf := make([]byte, n) // -m: make([]byte, n) escapes to heap
	return buf[:0]
}

// ⑥ 固定但太大 → 逃逸（超过栈上分配阈值）
func escapeTooBig() int {
	var big [10 << 20]byte // -m: moved to heap: big （10MB 放不进栈帧预算）
	return int(big[0])
}

func main() {
	fmt.Println("== 每次调用的堆分配次数实测 (AllocsPerRun) ==")
	cases := []struct {
		name string
		fn   func()
	}{
		{"① 纯局部(不逃逸)", func() { _ = noEscape() }},
		{"② 返回指针", func() { _ = escapeReturnPtr() }},
		{"③ 存 interface", func() { escapeInterface() }},
		{"④ 闭包捕获", func() { _ = escapeClosure() }},
		{"⑤ 动态大小 make", func() { _ = escapeDynamicSize(64) }},
	}
	for _, c := range cases {
		allocs := testing.AllocsPerRun(1000, c.fn)
		verdict := "栈上, 零成本"
		if allocs > 0 {
			verdict = "逃逸 → 堆分配 → GC 要来收"
		}
		fmt.Printf("  %-22s %.0f 次/调用   %s\n", c.name, allocs, verdict)
	}
	_ = escapeTooBig() // ⑥ 单独跑一次即可（10MB 的分配放进循环没必要）

	fmt.Println(`
验证方式: go build -gcflags='-m' ./03_memory/02_escape_analysis
优化姿势: 热路径上——
  返回值代替返回指针(小结构体) / 预分配+传入 buf 代替内部 make /
  避免无谓的 interface 装箱(泛型或具体类型) / strings.Builder 攒串`)
}
