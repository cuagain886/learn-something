/*
═══════════════════════════════════════════════════════════════════

	11_methods —— 方法：给类型绑定行为

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. 方法定义：带"接收者(receiver)"的函数
 2. 值接收者 vs 指针接收者 ★本节核心，选错会出 bug
 3. 任何自定义类型都能有方法（不限于结构体！）
 4. 嵌入带来的方法提升

【运行】go run ./11_methods

【与面向对象语言的对照】
  - Java/Python 把方法写在 class 体内；Go 把方法写在类型【外面】，
    用接收者声明"这个函数属于谁"——数据和行为定义分离，但逻辑上绑定
  - 接收者就是其他语言里的 this / self，但要【显式命名】（惯例用 1-2 个字母）
*/
package main

import (
	"fmt"
	"math"
)

// ───────────────────────────────────────────────────────────────
// 1. 方法 = 带接收者的函数
// ───────────────────────────────────────────────────────────────
type Circle struct {
	Radius float64
}

// 语法：func (接收者名 接收者类型) 方法名(参数) 返回值 { }
//
//	└──────────┬──────────┘
//	  就比普通函数多了这一段
//
// 接收者名惯例用类型首字母小写（c），不叫 this/self
func (c Circle) Area() float64 {
	return math.Pi * c.Radius * c.Radius // 通过接收者访问字段
}

func (c Circle) Circumference() float64 {
	return 2 * math.Pi * c.Radius
}

// ───────────────────────────────────────────────────────────────
// 2. 值接收者 vs 指针接收者 ★★★ 本节最重要的知识点
// ───────────────────────────────────────────────────────────────
type Counter struct {
	count int
}

// 值接收者 (c Counter)：方法操作的是【副本】，修改对原对象无效！
func (c Counter) IncrBroken() {
	c.count++ // 改的是副本的字段，方法结束副本就丢弃了
}

// 指针接收者 (c *Counter)：方法操作【原对象】，修改有效 ★需要改状态就用它
func (c *Counter) Incr() {
	c.count++ // 通过指针改原对象（自动解引用，不用写 (*c).count）
}

// 读操作用值接收者没问题
func (c Counter) Value() int {
	return c.count
}

// ───────────────────────────────────────────────────────────────
// 3. 任何"具名类型"都可以有方法 —— 不限于结构体！
// ───────────────────────────────────────────────────────────────
// 基于基本类型定义新类型，再挂方法 —— 让基础数据拥有领域行为
type Celsius float64 // 摄氏温度：本质是 float64，但是个独立的新类型

func (c Celsius) ToFahrenheit() float64 { // 给"温度"挂上转换方法
	return float64(c)*9/5 + 32
}

func (c Celsius) Describe() string {
	switch { // 无表达式 switch（第 04 节讲过）
	case c < 0:
		return "冰点以下"
	case c < 18:
		return "有点冷"
	case c < 28:
		return "舒适"
	default:
		return "炎热"
	}
}

// 切片类型也能挂方法
type IntList []int

func (l IntList) Sum() int {
	total := 0
	for _, v := range l {
		total += v
	}
	return total
}

// ───────────────────────────────────────────────────────────────
// 4. 嵌入 + 方法提升：组合出"伪继承"
// ───────────────────────────────────────────────────────────────
type Engine struct {
	Power int
}

func (e *Engine) Start() { // Engine 的方法
	fmt.Printf("  引擎启动（%d 马力）\n", e.Power)
}

type Car struct {
	Engine // 嵌入：Engine 的方法被提升为 Car 的方法
	Brand  string
}

// Car 也可以定义自己的同名方法来"覆盖"（其实是遮蔽）提升的方法
func (c *Car) Describe() {
	fmt.Printf("  %s 牌汽车\n", c.Brand)
}

func main() {
	fmt.Println("══════ 1. 调用方法 ══════")
	c := Circle{Radius: 2}
	// 调用语法和其他语言一样：对象.方法()
	fmt.Printf("半径 %.0f 的圆: 面积 %.2f, 周长 %.2f\n",
		c.Radius, c.Area(), c.Circumference())

	fmt.Println("\n══════ 2. 值接收者 vs 指针接收者 ══════")
	counter := Counter{}

	counter.IncrBroken() // 值接收者：改副本
	counter.IncrBroken()
	fmt.Println("IncrBroken 两次后:", counter.Value()) // 还是 0！⚠️

	counter.Incr() // 指针接收者：改原件
	counter.Incr()
	counter.Incr()
	fmt.Println("Incr 三次后:", counter.Value()) // 3 ✓

	// ★ 语法糖：counter 是值，但调用指针方法时编译器自动取址
	//   counter.Incr() 自动变成 (&counter).Incr()
	//   反方向也行：指针调用值方法会自动解引用
	//   ⚠️ 例外：只有"可寻址"的值才能自动取址；map 元素、临时值不行

	// 【选择规则】（社区共识）：
	//   1. 方法要修改接收者 => 必须指针接收者
	//   2. 结构体很大 => 指针接收者（避免拷贝）
	//   3. 类型有任何一个方法用了指针接收者 => 全部方法统一用指针（一致性）
	//   4. 小型、不可变、值语义的类型（如 time.Time）=> 值接收者

	fmt.Println("\n══════ 3. 给非结构体类型挂方法 ══════")
	temp := Celsius(26.5) // 显式转换：float64 -> Celsius
	fmt.Printf("%.1f°C = %.1f°F，体感: %s\n",
		float64(temp), temp.ToFahrenheit(), temp.Describe())

	nums := IntList{1, 2, 3, 4, 5}
	fmt.Println("IntList 求和:", nums.Sum())
	// ⚠️ 限制：只能给【本包定义的】类型挂方法。
	// 不能直接给 int、string 或别的包的类型加方法 ——
	// 想扩展就像 Celsius 这样先 type 一个新类型。

	fmt.Println("\n══════ 4. 方法提升 ══════")
	car := Car{Engine: Engine{Power: 300}, Brand: "Gopher"}
	car.Start()    // ★ Start 定义在 Engine 上，被提升，像 Car 自己的方法
	car.Describe() // Car 自己的方法

	fmt.Println("\n══════ 5. 方法值与方法表达式（进阶）══════")
	// 方法也是值，可以赋给变量 —— 绑定了接收者的叫"方法值"
	area := c.Area // 绑定 c 的 Area 方法（不调用，没有括号）
	fmt.Println("方法值调用:", area())

	// "方法表达式"：把方法当普通函数用，接收者变成第一个参数
	areaFn := Circle.Area // 类型是 func(Circle) float64
	fmt.Println("方法表达式调用:", areaFn(Circle{Radius: 1}))
}
