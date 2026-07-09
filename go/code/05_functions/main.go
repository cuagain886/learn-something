/*
═══════════════════════════════════════════════════════════════════

	05_functions —— 函数：多返回值、闭包、defer

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. 函数定义、参数、多返回值（Go 的标志性特性）
 2. 命名返回值、变长参数
 3. 函数是一等公民：函数值、匿名函数、闭包
 4. defer：延迟执行 —— Go 的资源清理利器

【运行】go run ./05_functions

【与其他语言的核心差异】
  - 多返回值是原生语法，错误处理全靠它（值 + error 成对返回）
  - 没有默认参数、没有函数重载、没有可选参数 —— Go 刻意保持简单
  - 所有参数都是【值传递】（拷贝）；想修改原值要传指针（第 09 节）
*/
package main

import (
	"errors"
	"fmt"
)

// ───────────────────────────────────────────────────────────────
// 1. 基本函数定义
// ───────────────────────────────────────────────────────────────
// 语法：func 函数名(参数名 类型, ...) 返回值类型 { }
// 同样遵循"类型后置"：参数类型写在参数名后面
func add(a int, b int) int {
	return a + b
}

// 连续多个参数类型相同时，可以只在最后写一次类型
func multiply(a, b, c int) int {
	return a * b * c
}

// 没有返回值就不写返回类型（没有 void 关键字）
func sayHello(name string) {
	fmt.Println("你好,", name)
}

// ───────────────────────────────────────────────────────────────
// 2. 多返回值 —— Go 最具代表性的设计
// ───────────────────────────────────────────────────────────────
// 多个返回值类型用圆括号包起来。
// 最经典的模式：(结果, error)。调用方必须显式处理第二个返回值，
// 这就是 Go 没有 try/catch 也能可靠处理错误的基础（第 13 节细讲）。
func divide(a, b float64) (float64, error) {
	if b == 0 {
		// 出错时：返回零值 + 错误对象
		return 0, errors.New("除数不能为零")
	}
	// 成功时：返回结果 + nil（nil 表示"没有错误"）
	return a / b, nil
}

// ───────────────────────────────────────────────────────────────
// 3. 命名返回值：返回值预先起名，函数内当普通变量用
// ───────────────────────────────────────────────────────────────
// - 进入函数时 width/height 已被初始化为零值
// - 裸 return（不带值）会自动返回当前的 width, height
// - 适合短函数提升可读性；长函数里裸 return 反而难读，慎用
func splitResolution(total int) (width, height int) {
	width = total * 16 / 25 // 直接给命名返回值赋值
	height = total * 9 / 25
	return // 裸 return：等价于 return width, height
}

// ───────────────────────────────────────────────────────────────
// 4. 变长参数（variadic）：类型前加 ...，效果同 Python 的 *args
// ───────────────────────────────────────────────────────────────
// nums 在函数内部就是一个 []int 切片；变长参数必须是最后一个参数
func sum(label string, nums ...int) int {
	total := 0
	for _, n := range nums { // 像普通切片一样遍历
		total += n
	}
	fmt.Printf("  %s 共 %d 个数，和为 %d\n", label, len(nums), total)
	return total
}

func main() {
	fmt.Println("══════ 1. 基本调用与多返回值 ══════")
	fmt.Println("add(3,4) =", add(3, 4))
	fmt.Println("multiply(2,3,4) =", multiply(2, 3, 4))
	sayHello("Gopher")

	// 接收多返回值：用逗号分别接收
	result, err := divide(10, 3)
	if err != nil { // ★ Go 错误处理的标准姿势：调用后立刻判 err
		fmt.Println("出错了:", err)
	} else {
		fmt.Printf("10/3 = %.4f\n", result)
	}

	// 除零演示：拿到的是错误而不是异常崩溃
	_, err = divide(1, 0)
	fmt.Println("除以零的错误:", err)

	// 只关心其中一个返回值时，用 _ 丢弃另一个（不能直接不接收）
	q, _ := divide(20, 4)
	fmt.Println("只要结果:", q)

	fmt.Println("\n══════ 2. 命名返回值与变长参数 ══════")
	w, h := splitResolution(100)
	fmt.Printf("分辨率: %d x %d\n", w, h)

	sum("三个数", 1, 2, 3) // 直接传任意个数
	sum("没有数")          // 传 0 个也合法，nums 是空切片
	scores := []int{90, 85, 77}
	sum("切片展开", scores...) // ★ 切片传给变长参数要加 ... 展开

	fmt.Println("\n══════ 3. 函数是一等公民 ══════")
	// 函数可以赋值给变量 —— 变量的类型是"函数类型" func(int, int) int
	var op func(int, int) int // 声明一个函数类型的变量（零值是 nil）
	op = add                  // 把函数 add 本身（不是调用结果）赋给它
	fmt.Println("通过变量调用 op(5,6) =", op(5, 6))

	// 匿名函数：定义后立即赋值给变量，或直接调用
	square := func(x int) int { return x * x } // 没有名字的函数
	fmt.Println("square(9) =", square(9))

	func() { // 定义后立即执行（IIFE），常用于初始化一小段逻辑
		fmt.Println("匿名函数立即执行")
	}()

	// 函数作为参数（高阶函数）：实现策略/回调
	apply := func(nums []int, f func(int) int) []int {
		out := make([]int, 0, len(nums)) // make 创建切片，第 06 节讲
		for _, n := range nums {
			out = append(out, f(n)) // 对每个元素应用传入的函数
		}
		return out
	}
	fmt.Println("全部平方:", apply([]int{1, 2, 3, 4}, square))
	fmt.Println("全部翻倍:", apply([]int{1, 2, 3, 4}, func(x int) int { return x * 2 }))

	fmt.Println("\n══════ 4. 闭包：函数 + 它捕获的环境 ══════")
	// 闭包 = 匿名函数引用了外层函数的局部变量。
	// 被捕获的变量生命周期被延长，跟着闭包走（逃逸到堆上）。
	counter := makeCounter() // 拿到一个闭包
	fmt.Println(counter())   // 1
	fmt.Println(counter())   // 2
	fmt.Println(counter())   // 3 —— count 变量在调用之间一直存活！

	counter2 := makeCounter()            // 再造一个：拥有【独立】的 count
	fmt.Println("counter2:", counter2()) // 1，互不影响

	fmt.Println("\n══════ 5. defer：延迟到函数返回前执行 ══════")
	demoDefer()
	fmt.Println("defer 处理文件的典型范式见函数 deferPattern 的注释")
	deferWithLoop()
}

// makeCounter 返回一个闭包：每次调用闭包，计数加一
func makeCounter() func() int {
	count := 0 // 这个变量被下面的匿名函数"捕获"
	return func() int {
		count++ // 修改的是外层的 count，而不是副本
		return count
	}
}

// demoDefer 演示 defer 的三条规则
func demoDefer() {
	// 规则一：defer 后面的函数调用，推迟到【所在函数 return 之后】才执行
	defer fmt.Println("  (4) defer：函数结束时才打印我")

	// 规则二：多个 defer 按【后进先出】（栈）顺序执行
	defer fmt.Println("  (3) 后注册的 defer 先执行")

	// 规则三：defer 语句的【参数在注册时就求值】，不是执行时
	x := 1
	defer fmt.Println("  (2) 注册 defer 时 x =", x) // 打印 1，不是 99
	x = 99

	fmt.Println("  (1) 函数体正常逻辑，此时 x =", x)
	// 函数到这里结束，开始按 (2)(3)(4) 标注的顺序倒序执行 defer
}

// deferPattern 演示 defer 的真实用途：成对的"打开/关闭"操作写在一起
// （为避免真的创建文件，这里只展示形态，不实际运行）
//
//	f, err := os.Open("data.txt")
//	if err != nil {
//	    return err
//	}
//	defer f.Close() // ★ 打开成功后立刻 defer 关闭——之后任何路径返回都会关闭
//	... 放心使用 f，任何 return 或 panic 都不会漏掉 Close ...
//
// 同样的范式适用于：解锁互斥锁 defer mu.Unlock()、关闭数据库连接、
// 事务回滚、计时统计等。这是 Go 替代 try/finally 的方案。
func deferWithLoop() {
	// ⚠️ 陷阱：defer 是函数级的，不是块级的！
	// 在循环里 defer，要等【整个函数】结束才执行，循环很大时会积压资源。
	// 错误示范（如果循环打开 1000 个文件，会同时占用 1000 个句柄）：
	//   for _, name := range files {
	//       f, _ := os.Open(name)
	//       defer f.Close() // 全部积压到函数末尾！
	//   }
	// 正确做法：把循环体提取成一个函数，让 defer 在每轮结束时执行。
	fmt.Println("  （deferWithLoop 的陷阱说明见源码注释）")
}
