/*
═══════════════════════════════════════════════════════════════════

	14_generics —— 泛型（Go 1.18+）：类型参数

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. 泛型函数：[T any] 类型参数语法
 2. 约束（constraint）：comparable、自定义约束接口、~ 波浪号
 3. 泛型类型：泛型结构体（如类型安全的栈）
 4. 什么时候用泛型、什么时候不用

【运行】go run ./14_generics

【背景】

	Go 诞生后 12 年都没有泛型，社区靠 any + 类型断言或代码生成硬扛。
	1.18（2022 年）终于加入。Go 泛型刻意比 C++/Rust 的简单：
	没有特化、没有元编程，就是"带类型参数的函数和类型"。
*/
package main

import (
	"cmp" // 标准库约束包：cmp.Ordered = 所有可比大小的类型
	"fmt"
)

// ───────────────────────────────────────────────────────────────
// 1. 第一个泛型函数
// ───────────────────────────────────────────────────────────────
// 方括号里是【类型参数列表】：T 是类型参数，any 是它的约束（任何类型都行）。
// 调用时 T 会被替换成具体类型 —— 编译期完成，类型安全，无运行时开销。
func First[T any](s []T) T {
	return s[0] // T 是什么类型，返回值就是什么类型——调用方无需断言
}

// 对比一下没有泛型的两种旧写法的缺点：
//   func First(s []any) any        // 丢失类型，取出后要断言，还能塞错类型
//   func FirstInt(s []int) int ... // 每种类型抄一份，FirstString、FirstFloat...

// ───────────────────────────────────────────────────────────────
// 2. 约束：限定类型参数能做什么
// ───────────────────────────────────────────────────────────────
// any 约束下，T 的值几乎什么都不能做（不能 +、不能 <、不能 ==）。
// 想用某种操作，就要收紧约束：

// comparable：内置约束，允许 == 和 !=（map 的键也要求这个）
func IndexOf[T comparable](s []T, target T) int {
	for i, v := range s {
		if v == target { // 因为约束是 comparable，这里才允许用 ==
			return i
		}
	}
	return -1 // 找不到
}

// cmp.Ordered：标准库约束，允许 < <= > >=（数值 + 字符串）
func Max[T cmp.Ordered](a, b T) T {
	if a > b { // Ordered 约束让 > 合法
		return a
	}
	return b
}

// 自定义约束：约束本质就是接口！用 | 列出允许的类型集合
type Number interface {
	~int | ~int32 | ~int64 | ~float32 | ~float64
	// ~int 的波浪号：不仅匹配 int 本身，还匹配【底层类型是 int】的自定义
	// 类型（如 type Age int）。没有 ~ 就只认 int 本尊。
}

// Sum 对任何数值切片求和 —— 一份代码服务所有数值类型
func Sum[T Number](nums []T) T {
	var total T // 类型参数的零值写法：var x T
	for _, n := range nums {
		total += n // Number 约束保证 + 可用
	}
	return total
}

// 多个类型参数：K 和 V 各自有约束
// 例：把 map 的所有键收集成切片（标准库 maps.Keys 的简化版）
func Keys[K comparable, V any](m map[K]V) []K {
	keys := make([]K, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	return keys
}

// 函数作为参数的泛型：实现通用 Map / Filter（其他语言的高阶函数）
func MapSlice[T, U any](s []T, f func(T) U) []U {
	out := make([]U, 0, len(s))
	for _, v := range s {
		out = append(out, f(v)) // 把每个 T 变换成 U
	}
	return out
}

func Filter[T any](s []T, keep func(T) bool) []T {
	out := []T{}
	for _, v := range s {
		if keep(v) { // 只保留判定为 true 的元素
			out = append(out, v)
		}
	}
	return out
}

// ───────────────────────────────────────────────────────────────
// 3. 泛型类型：带类型参数的结构体
// ───────────────────────────────────────────────────────────────
// 经典案例：类型安全的栈。Stack[int] 和 Stack[string] 是不同的具体类型，
// 往 Stack[int] 里压字符串是【编译错误】——这是 any 方案给不了的安全性。
type Stack[T any] struct {
	items []T // 字段也可以用类型参数
}

// 泛型类型的方法：接收者要带上类型参数 [T]
func (s *Stack[T]) Push(v T) {
	s.items = append(s.items, v)
}

// Pop 弹出栈顶；第二个返回值表示栈是否非空（comma-ok 风格）
func (s *Stack[T]) Pop() (T, bool) {
	if len(s.items) == 0 {
		var zero T // 拿不出元素时返回 T 的零值
		return zero, false
	}
	last := s.items[len(s.items)-1]    // 取栈顶
	s.items = s.items[:len(s.items)-1] // 缩短切片完成弹出
	return last, true
}

func (s *Stack[T]) Len() int { return len(s.items) }

func main() {
	fmt.Println("══════ 1. 泛型函数调用 ══════")
	// 多数情况下编译器能根据实参【自动推断】类型参数，无需显式写
	fmt.Println("First([]int):   ", First([]int{10, 20, 30}))  // T 推断为 int
	fmt.Println("First([]string):", First([]string{"a", "b"})) // T 推断为 string
	// 也可以显式指定（推断不出来或想强调时）
	fmt.Println("显式指定:       ", First[float64]([]float64{1.5, 2.5}))

	fmt.Println("\n══════ 2. 各种约束 ══════")
	fmt.Println("IndexOf 找 'b':", IndexOf([]string{"a", "b", "c"}, "b")) // 1
	fmt.Println("Max(3, 7)     :", Max(3, 7))                            // 7
	fmt.Println("Max(\"go\",\"py\"):", Max("go", "py"))                  // py（字典序）

	fmt.Println("Sum ints      :", Sum([]int{1, 2, 3}))      // 6
	fmt.Println("Sum floats    :", Sum([]float64{1.1, 2.2})) // 3.3...
	type Score int                                           // 自定义类型
	fmt.Println("Sum ~int 类型 :", Sum([]Score{90, 85}))       // ~ 的作用：Score 也能用！

	ages := map[string]int{"小明": 25, "小红": 23}
	fmt.Println("Keys          :", Keys(ages)) // 顺序随机（map 特性）

	fmt.Println("\n══════ 3. 泛型高阶函数 ══════")
	nums := []int{1, 2, 3, 4, 5, 6}
	// T=int, U=string 的变换
	words := MapSlice(nums, func(n int) string { return fmt.Sprintf("#%d", n) })
	fmt.Println("MapSlice:", words)
	evens := Filter(nums, func(n int) bool { return n%2 == 0 })
	fmt.Println("Filter 偶数:", evens)

	fmt.Println("\n══════ 4. 泛型栈 ══════")
	var si Stack[int] // 实例化：T = int
	si.Push(1)
	si.Push(2)
	si.Push(3)
	// si.Push("x") // 编译错误！类型安全 ★这就是泛型的价值
	for si.Len() > 0 {
		v, _ := si.Pop()
		fmt.Print(v, " ") // 3 2 1（后进先出）
	}
	fmt.Println()

	ss := Stack[string]{} // 同一份代码，实例化成字符串栈
	ss.Push("hello")
	top, ok := ss.Pop()
	fmt.Println("字符串栈弹出:", top, ok)
	_, ok = ss.Pop() // 空栈
	fmt.Println("空栈弹出 ok =", ok)

	fmt.Println("\n══════ 5. 使用建议 ══════")
	fmt.Println(`  该用泛型：容器/数据结构（栈、集合、缓存）、
            对多种类型做同样操作的工具函数（Max/Sum/Filter）
  不该用泛型：只有一种类型在用（直接写具体类型）、
            行为因类型而异（那是接口的领域！）
  ★ 经验：先写具体代码，出现第二三处重复时再提炼泛型；
    接口表达"行为抽象"，泛型表达"同样逻辑套不同类型"，不要混用。`)
}
