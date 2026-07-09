/*
═══════════════════════════════════════════════════════════════════

	02_variables —— 变量、常量与基本类型

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. 变量声明的几种方式：var、:=（短声明）
 2. 零值（zero value）：Go 没有"未初始化"的变量
 3. 基本类型：整数、浮点、布尔、字符串、复数
 4. 常量 const 与 iota 枚举生成器
 5. 类型转换：必须显式，没有隐式转换！

【运行】go run ./02_variables

【与其他语言的核心差异】
  - 类型写在变量名【后面】：var x int（而不是 int x）
    理由：从左往右读更自然 ——"变量 x 是 int 类型"
  - 没有隐式类型转换：int 和 int64 相加都要显式转换，杜绝一类隐蔽 bug
  - 声明了不使用 => 编译错误（仅局部变量；全局变量和常量允许不用）
*/
package main

import "fmt" // 只导入一个包时可以不用括号分组

// ───────────────────────────────────────────────────────────────
// 包级（全局）变量：在函数外只能用 var 声明，不能用 :=
// ───────────────────────────────────────────────────────────────
var globalCounter int = 100 // 完整写法：var 名字 类型 = 初始值

// 类型可以省略，编译器根据右侧值自动推断（这里推断为 string）
var appName = "Go 学习教程"

// 一组相关变量可以用括号批量声明（gofmt 会自动对齐）
var (
	width  = 1920 // 推断为 int
	height = 1080 // 推断为 int
)

func main() {
	fmt.Println("══════ 1. 变量声明的方式 ══════")

	// 方式一：var 名字 类型 = 值（最完整的形式）
	var age int = 30
	fmt.Println("age =", age)

	// 方式二：var 名字 = 值（省略类型，自动推断）
	var city = "北京" // 推断为 string
	fmt.Println("city =", city)

	// 方式三：var 名字 类型（不给初始值 => 自动初始化为"零值"，见下一节）
	var score float64
	fmt.Println("score 的零值 =", score) // 输出 0

	// 方式四：短变量声明 :=（函数内最常用！）
	// 等价于 var country = "中国"，但只能在【函数内部】使用
	country := "中国"
	fmt.Println("country =", country)

	// 一行声明多个变量（常用于接收函数的多个返回值，第 05 节讲）
	x, y := 10, 20
	fmt.Println("x =", x, "y =", y)

	// ⚠️ 陷阱：:= 是"声明并赋值"，= 是"仅赋值"
	// 对已存在的变量再用 := 会报错（除非左边至少有一个是新变量）
	x = 99 // 正确：x 已声明，用 = 重新赋值
	fmt.Println("重新赋值后 x =", x)

	fmt.Println("\n══════ 2. 零值：Go 没有未初始化的变量 ══════")
	// 任何变量声明后不赋值，都会自动获得其类型的"零值"，
	// 因此 Go 中不存在 C 那样读到内存垃圾值的问题。
	var i int     // 数值类型零值: 0
	var f float64 // 浮点零值:    0
	var b bool    // 布尔零值:    false
	var s string  // 字符串零值:  ""（空串，不是 nil！）
	var p *int    // 指针零值:    nil（第 09 节讲指针）
	fmt.Printf("int=%v float64=%v bool=%v string=%q 指针=%v\n", i, f, b, s, p)
	// %q 给字符串加引号打印，能看出 "" 是空串

	fmt.Println("\n══════ 3. 基本类型一览 ══════")
	// ── 整数类型 ──
	// 有符号: int8  int16  int32  int64  和 int（平台相关，64位系统上是64位）
	// 无符号: uint8 uint16 uint32 uint64 和 uint、uintptr
	// 别名:   byte = uint8（表示原始字节）、rune = int32（表示 Unicode 码点）
	// 【惯例】没有特殊理由就用 int，不要纠结大小
	var big int64 = 9_000_000_000 // 数字字面量可用下划线分隔，增强可读性
	var bt byte = 'A'             // 单引号是"字符字面量"，值是其编码 65
	var r rune = '中'              // rune 存 Unicode 码点，'中' 是 20013
	fmt.Println("int64:", big, " byte:", bt, " rune:", r)

	// ── 浮点类型 ──
	// 只有 float32 和 float64，【惯例】总是用 float64（精度高）
	var pi float64 = 3.14159
	fmt.Println("pi =", pi)
	// ⚠️ 陷阱：浮点数不精确，比较时不要用 ==
	fmt.Println("0.1+0.2 == 0.3 ?", 0.1+0.2 == 0.3) // false！

	// ── 布尔类型 ──
	// 只有 true / false；⚠️ 不能像 Python/C 那样把数字当布尔用
	// if 1 { ... }  // 编译错误！条件必须是 bool 类型
	var ok bool = true
	fmt.Println("ok =", ok)

	// ── 字符串 ──（第 08 节详细讲）
	// 双引号：普通字符串，支持 \n \t 等转义
	// 反引号：原始字符串，不转义、可跨行（写正则、JSON 模板很方便）
	plain := "第一行\n第二行"
	raw := `原始字符串：\n 不会被转义，
还能直接换行`
	fmt.Println(plain)
	fmt.Println(raw)

	fmt.Println("\n══════ 4. 常量 const 与 iota ══════")
	// 常量在编译期确定，运行期不可修改；只能是基本类型（数值/字符串/布尔）
	const MaxRetries = 3
	const Greeting = "你好"
	// MaxRetries = 5 // 编译错误：常量不可重新赋值
	fmt.Println(MaxRetries, Greeting)

	// 无类型常量（untyped constant）：未指定类型的常量精度极高，
	// 且可以灵活地用于任何兼容的类型场景，这是 Go 常量系统的特色
	const Big = 1 << 40 // 1TB，超出 int32 范围也没关系
	fmt.Println("1<<40 =", Big)

	// iota：常量组中的自增计数器，从 0 开始，每行 +1，用来做枚举
	// Go 没有 enum 关键字，惯用法就是 const + iota
	const (
		StatusPending  = iota // 0（iota 在本 const 组第一行 = 0）
		StatusRunning         // 1（省略表达式则沿用上一行，iota 自动 +1）
		StatusFinished        // 2
		StatusFailed          // 3
	)
	fmt.Println("状态枚举:", StatusPending, StatusRunning, StatusFinished, StatusFailed)

	// iota 配合位运算定义标志位（flag）的经典写法
	const (
		ReadPerm  = 1 << iota // 1 << 0 = 1（二进制 001）
		WritePerm             // 1 << 1 = 2（二进制 010）
		ExecPerm              // 1 << 2 = 4（二进制 100）
	)
	fmt.Println("权限位:", ReadPerm, WritePerm, ExecPerm)

	fmt.Println("\n══════ 5. 类型转换：必须显式！ ══════")
	// Go 没有任何隐式类型转换（C/Java 的自动提升在这里不存在）
	// 语法：目标类型(值)
	var a int = 65
	var c float64 = float64(a) // int -> float64 必须写出来
	var d int64 = int64(a)     // int -> int64 也必须写！它们是不同类型
	fmt.Println(a, c, d)

	// var e int = a + d        // 编译错误：int 和 int64 不能直接相加
	e := a + int(d) // 正确：转换成同一类型后再运算
	fmt.Println("a + int(d) =", e)

	// ⚠️ 陷阱：大类型转小类型会【静默截断】，不报错也不 panic
	var huge int64 = 300
	var small int8 = int8(huge) // int8 范围是 -128~127，300 截断成 44
	fmt.Println("300 转 int8 =", small)

	// 数字与字符串的转换【不能】用这种语法，要用 strconv 包（第 08 节讲）
	// string(65) 得到的是字符 "A" 而不是 "65" ——这是新手最常踩的坑之一

	 // 输出 "A"，不是 "65"
	fmt.Println("\n══════ 6. 查看变量类型 ══════")
	// %T 动词打印值的类型，调试时很有用
	fmt.Printf("globalCounter 是 %T，appName 是 %T，pi 是 %T\n",
		globalCounter, appName, pi)
	// 空白标识符 _：表示"显式丢弃这个值"。
	// 常见用途：忽略函数的某个返回值，或对局部变量绕过"未使用"编译错误。
	// （注：包级变量 width/height 即使不用也不会报错，这里仅演示 _ 的语法）
	_ = width
	_ = height
}
