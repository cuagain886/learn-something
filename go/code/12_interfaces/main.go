/*
═══════════════════════════════════════════════════════════════════

	12_interfaces —— 接口：Go 多态的唯一来源

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. 接口定义与【隐式实现】（没有 implements 关键字！）
 2. 接口值、nil 接口
 3. 类型断言（type assertion）与类型分支（type switch）
 4. 空接口 any、标准库惯用接口（Stringer / error）

【运行】go run ./12_interfaces

【与其他语言的核心差异】
  - Java/C#：类必须显式声明 implements X
  - Go：只要类型拥有接口要求的全部方法，就【自动】实现该接口
    （"鸭子类型"，但在编译期静态检查 —— 安全的鸭子）
  - 好处：可以为【别人的】类型定义接口，先有实现后有抽象，解耦彻底
  - 惯例：接口要小（1-2 个方法最佳），名字常以 -er 结尾（Reader/Writer/Stringer）
*/
package main

import (
	"fmt"
	"math"
	"strings"
)

// ───────────────────────────────────────────────────────────────
// 1. 定义接口：方法签名的集合
// ───────────────────────────────────────────────────────────────
// 任何拥有 Area() float64 和 Perimeter() float64 两个方法的类型，
// 都自动是 Shape —— 不需要任何声明！
type Shape interface {
	Area() float64 // 只写方法签名，没有实现
	Perimeter() float64
}

// ── 实现一：矩形 ──（注意：下面没有任何 "implements Shape" 字样）
type Rect struct {
	W, H float64
}

func (r Rect) Area() float64      { return r.W * r.H }
func (r Rect) Perimeter() float64 { return 2 * (r.W + r.H) }

// ── 实现二：圆形 ──
type Circle struct {
	R float64
}

func (c Circle) Area() float64      { return math.Pi * c.R * c.R }
func (c Circle) Perimeter() float64 { return 2 * math.Pi * c.R }

// 接收接口的函数：不关心传进来的具体是什么，只要它"会算面积和周长"
// —— 这就是多态：同一段代码对不同类型表现出不同行为
func printShapeInfo(s Shape) {
	fmt.Printf("  %T: 面积=%.2f 周长=%.2f\n", s, s.Area(), s.Perimeter())
}

// ───────────────────────────────────────────────────────────────
// 2. 标准库惯用接口一：fmt.Stringer —— 自定义打印格式
// ───────────────────────────────────────────────────────────────
// 标准库定义：type Stringer interface { String() string }
// 实现了它，fmt 系列函数打印该类型时就会调用你的 String()
// （相当于 Java 的 toString() / Python 的 __str__）
type Temperature float64

func (t Temperature) String() string {
	return fmt.Sprintf("%.1f℃", float64(t)) // 注意要转回 float64 防止无限递归
}

func main() {
	fmt.Println("══════ 1. 隐式实现与多态 ══════")
	// 接口类型的变量可以装下任何实现了该接口的值
	var s Shape          // 接口零值是 nil
	s = Rect{W: 3, H: 4} // Rect 自动实现了 Shape，可以直接赋值
	printShapeInfo(s)
	s = Circle{R: 5} // 换成 Circle 也行
	printShapeInfo(s)

	// 接口切片：异构集合 —— 不同具体类型放进同一个切片
	shapes := []Shape{
		Rect{W: 1, H: 2},
		Circle{R: 1},
		Rect{W: 5, H: 5},
	}
	total := 0.0
	for _, sh := range shapes {
		total += sh.Area() // 每个元素调用各自类型的 Area 实现
	}
	fmt.Printf("  总面积: %.2f\n", total)

	fmt.Println("\n══════ 2. 接口值的内部结构与 nil 陷阱 ══════")
	// 接口值 = (动态类型, 动态值) 二元组。
	// 只有【两者都为 nil】时接口才 == nil。
	var sp *Rect = nil                          // 一个 nil 的具体类型指针
	var iface Shape = sp                        // 装进接口：动态类型=*Rect，动态值=nil
	fmt.Println("iface == nil ?", iface == nil) // false！⚠️ 经典面试坑
	// ⚠️ 教训：函数声明返回 error（接口）时，
	// 不要返回"有类型的 nil 指针"，要直接 return nil

	fmt.Println("\n══════ 3. 类型断言：从接口里取回具体类型 ══════")
	var any1 Shape = Circle{R: 2}

	// 形式一：v := i.(T) —— 断言失败直接 panic，少用
	c := any1.(Circle)
	fmt.Println("  断言成功，半径 =", c.R)

	// 形式二：v, ok := i.(T) ★安全版，失败时 ok=false 不 panic
	if r, ok := any1.(Rect); ok {
		fmt.Println("  是矩形", r)
	} else {
		fmt.Println("  不是矩形（ok =", ok, "）")
	}

	fmt.Println("\n══════ 4. type switch：按类型分支 ══════")
	// 一次性判断多种类型的优雅写法（语法：i.(type) 只能出现在 switch 里）
	describeAll := []any{42, "hello", 3.14, true, Circle{R: 1}, nil}
	for _, v := range describeAll {
		describe(v)
	}

	fmt.Println("\n══════ 5. 空接口 any：能装任何值 ══════")
	// interface{} 没有任何方法 => 所有类型都自动实现它
	// Go 1.18 起 any 是 interface{} 的官方别名，写 any 即可
	var box any
	box = 123
	box = "字符串也行"
	box = []int{1, 2, 3}
	fmt.Printf("  box 现在装着 %T: %v\n", box, box)
	// ⚠️ 代价：放进 any 就丢失了静态类型信息，取出来必须断言，
	// 滥用 any 等于放弃编译期检查。能用泛型（第 14 节）就别用 any。

	fmt.Println("\n══════ 6. Stringer 接口实战 ══════")
	temp := Temperature(36.6)
	fmt.Println("实现 String() 后直接打印:", temp) // 自动调用 -> 36.6℃
	// error 也是接口：type error interface { Error() string }
	// 它是 Go 错误处理体系的根基，下一节（13_errors）专门讲

	fmt.Println("\n══════ 7. 接口设计哲学 ══════")
	// 标准库的 io.Reader / io.Writer 只有一个方法，却撑起了整个 IO 生态：
	//   type Writer interface { Write(p []byte) (n int, err error) }
	// 文件、网络连接、内存缓冲、压缩器……都实现了它，组合自由。
	// strings.NewReader 把字符串变成 Reader，体验一下"面向接口编程"：
	reader := strings.NewReader("面向接口而非实现")
	buf := make([]byte, 12)
	n, _ := reader.Read(buf) // 任何 Reader 都这样读
	fmt.Printf("  从 Reader 读了 %d 字节: %s\n", n, buf[:n])
	// 【准则】接受接口，返回结构体（Accept interfaces, return structs）
	// 【准则】接口由使用方定义，而不是实现方 —— 需要什么能力就声明什么
}

// describe 用 type switch 对未知类型的值分类处理
func describe(v any) {
	// 语法：switch 新变量 := 接口.(type)
	// 在每个 case 分支里，新变量自动具有该分支的具体类型！
	switch x := v.(type) {
	case int:
		fmt.Printf("  int: %d（可以直接做算术 x*2=%d）\n", x, x*2)
	case string:
		fmt.Printf("  string: %q（长度 %d）\n", x, len(x))
	case float64:
		fmt.Printf("  float64: %.2f\n", x)
	case bool:
		fmt.Printf("  bool: %t\n", x)
	case Shape: // 也可以按接口分支：满足 Shape 的都进这里
		fmt.Printf("  某种图形，面积 %.2f\n", x.Area())
	case nil:
		fmt.Println("  nil 值")
	default:
		fmt.Printf("  未知类型 %T\n", x)
	}
}
