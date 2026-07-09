/*
═══════════════════════════════════════════════════════════════════

	03_operators_fmt —— 运算符与 fmt 格式化输出

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. 算术、比较、逻辑、位运算符
 2. Go 运算符的几个特殊之处（++ 是语句、没有三元运算符等）
 3. fmt 包的格式化动词（%v %d %s %T %q ...）—— 以后调试全靠它

【运行】go run ./03_operators_fmt

【与其他语言的核心差异】
  - i++ 是【语句】不是表达式：不能写 x = i++，也没有 ++i
  - 没有三元运算符 a ? b : c，只能用 if/else（Go 追求"一件事一种写法"）
  - 没有 ** 幂运算符，要用 math.Pow
  - 除法：整数除整数得整数（截断），和 C/Java 一致，和 Python3 不同
*/
package main

import (
	"fmt"
	"math"
)

func main() {
	fmt.Println("══════ 1. 算术运算符 ══════")
	a, b := 13, 5 // 同时声明两个 int

	fmt.Println("a + b =", a+b) // 18  加
	fmt.Println("a - b =", a-b) // 8   减
	fmt.Println("a * b =", a*b) // 65  乘
	fmt.Println("a / b =", a/b) // 2   ⚠️ 整数除法自动截断小数部分！
	fmt.Println("a % b =", a%b) // 3   取余（结果符号跟随被除数）

	// 想要小数结果，必须先把操作数转成浮点
	fmt.Println("13/5 的浮点结果 =", float64(a)/float64(b)) // 2.6

	// 幂运算没有运算符，用 math.Pow（参数和返回值都是 float64）
	fmt.Println("2 的 10 次方 =", math.Pow(2, 10)) // 1024

	// 自增/自减：只有后缀形式，且是独立语句，不能参与表达式
	counter := 0
	counter++ // 等价于 counter = counter + 1
	counter-- // 等价于 counter = counter - 1
	// y := counter++   // 编译错误！++ 不是表达式，没有返回值
	// ++counter        // 编译错误！没有前缀形式
	fmt.Println("counter =", counter)

	// 复合赋值运算符与多数语言相同
	n := 10
	n += 5 // 15
	n *= 2 // 30
	n -= 6 // 24
	n /= 4 // 6
	n %= 4 // 2
	fmt.Println("n 最终 =", n)

	fmt.Println("\n══════ 2. 比较与逻辑运算符 ══════")
	// 比较运算符：== != < <= > >=，结果是 bool
	// ⚠️ 只能比较【相同类型】的值，int 和 int64 比较都要先转换
	fmt.Println("3 == 3.0 ?", 3 == 3.0) // true：常量在编译期可以互通
	x, y := 10, 20
	fmt.Println("x < y :", x < y)  // true
	fmt.Println("x != y:", x != y) // true

	// 逻辑运算符：&&（且） ||（或） !（非），支持短路求值
	age := 25
	hasTicket := true
	canEnter := age >= 18 && hasTicket // 两个条件都满足才为 true
	fmt.Println("可以入场:", canEnter)

	// 短路演示：&& 左边为 false 时右边根本不会执行
	// 这是安全访问的惯用手段，例如：if ptr != nil && ptr.Valid() {...}

	// 没有三元运算符！想表达 "条件 ? A : B" 只能这样写：
	var grade string
	if x > 15 {
		grade = "高"
	} else {
		grade = "低"
	}
	fmt.Println("grade =", grade)

	fmt.Println("\n══════ 3. 位运算符 ══════")
	p, q := 0b1100, 0b1010 // 0b 前缀表示二进制字面量（12 和 10）

	fmt.Printf("p & q  = %04b (按位与)\n", p&q)                            // 1000
	fmt.Printf("p | q  = %04b (按位或)\n", p|q)                            // 1110
	fmt.Printf("p ^ q  = %04b (按位异或)\n", p^q)                           // 0110
	fmt.Printf("p &^ q = %04b (按位清除，Go 特有：把 q 中为 1 的位在 p 中清零)\n", p&^q) // 0100
	fmt.Printf("p << 2 = %b (左移)\n", p<<2)                              // 110000
	fmt.Printf("p >> 2 = %b (右移)\n", p>>2)                              // 11
	// 注意：^ 作为【二元】运算符是异或，作为【一元】运算符是按位取反
	fmt.Printf("^p     = %d (按位取反)\n", ^p) // -13

	fmt.Println("\n══════ 4. fmt 格式化动词大全 ══════")
	// Printf 系列函数用"动词"（verb，% 开头）控制输出格式。
	// 这是 Go 日常调试最重要的工具，建议熟记下面这批：

	type point struct{ X, Y int } // 临时定义一个结构体用于演示（第 10 节细讲）
	pt := point{3, 4}

	// ── 万能动词 ──
	fmt.Printf("%%v  : %v\n", pt)  // {3 4}        默认格式，万物皆可打
	fmt.Printf("%%+v : %+v\n", pt) // {X:3 Y:4}    结构体带字段名 ★调试最常用
	fmt.Printf("%%#v : %#v\n", pt) // main.point{X:3, Y:4} Go 语法表示
	fmt.Printf("%%T  : %T\n", pt)  // main.point   打印类型

	// ── 整数 ──
	fmt.Printf("%%d : %d\n", 255)     // 255   十进制
	fmt.Printf("%%b : %b\n", 255)     // 11111111 二进制
	fmt.Printf("%%o : %o\n", 255)     // 377   八进制
	fmt.Printf("%%x : %x\n", 255)     // ff    十六进制小写
	fmt.Printf("%%X : %X\n", 255)     // FF    十六进制大写
	fmt.Printf("%%c : %c\n", 20013)   // 中    按 Unicode 码点输出字符
	fmt.Printf("%%5d : [%5d]\n", 42)  // [   42] 宽度 5，右对齐
	fmt.Printf("%%-5d: [%-5d]\n", 42) // [42   ] 宽度 5，左对齐
	fmt.Printf("%%05d: [%05d]\n", 42) // [00042] 不足补零

	// ── 浮点数 ──
	fmt.Printf("%%f   : %f\n", math.Pi)      // 3.141593 默认 6 位小数
	fmt.Printf("%%.2f : %.2f\n", math.Pi)    // 3.14     保留 2 位小数 ★常用
	fmt.Printf("%%8.2f: [%8.2f]\n", math.Pi) // [    3.14] 总宽 8，2 位小数
	fmt.Printf("%%e   : %e\n", 123456789.0)  // 1.234568e+08 科学计数法，保留小数点后六位，自动截断
	fmt.Printf("%%g   : %g\n", 123456789.0)  // 1.23456789e+08 自动选最短表示

	// ── 字符串 ──
	fmt.Printf("%%s : %s\n", "你好") // 你好     原样输出
	fmt.Printf("%%q : %q\n", "你好") // "你好"   加双引号 ★调试空串/空白很有用
	fmt.Printf("%%x : %x\n", "Go") // 476f     字符串的十六进制字节

	// ── 布尔与指针 ──
	fmt.Printf("%%t : %t\n", true) // true
	fmt.Printf("%%p : %p\n", &pt)  // 0xc0000140a0 变量的内存地址

	fmt.Println("\n══════ 5. fmt 的三大函数家族 ══════")
	// Print 系：输出到标准输出
	//   Print / Println / Printf —— 前面已演示
	// Sprint 系：不输出，而是【返回字符串】（S = String）★拼接格式化字符串
	msg := fmt.Sprintf("坐标是(%d, %d)，距离原点 %.1f", pt.X, pt.Y,
		math.Sqrt(float64(pt.X*pt.X+pt.Y*pt.Y)))
	fmt.Println(msg) // 坐标是(3, 4)，距离原点 5.0
	// Fprint 系：输出到指定目标（F = File，实际是任何 io.Writer，第 19 节讲）
	//   fmt.Fprintln(os.Stderr, "错误信息打到标准错误流")
	// Errorf：格式化生成一个 error 值（第 13 节错误处理详细讲）
	err := fmt.Errorf("处理第 %d 行时出错", 42)
	fmt.Println("err =", err)
}
