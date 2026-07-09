/*
═══════════════════════════════════════════════════════════════════

	10_structs —— 结构体：Go 的"类"（但没有继承）

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. 结构体定义与初始化的各种写法
 2. 嵌套结构体、结构体嵌入（组合代替继承 ★Go 的核心设计哲学）
 3. 匿名结构体、结构体标签（tag）
 4. 结构体比较与值语义

【运行】go run ./10_structs

【与面向对象语言的对照】
  - struct ≈ 类的"数据部分"；方法单独定义（第 11 节），二者物理分离
  - 没有继承！Go 用【嵌入（embedding）】实现组合与方法提升
  - 没有构造函数！惯例是写一个 NewXxx() 工厂函数
  - 字段首字母大写 = 公开，小写 = 包内私有（和函数同一条规则）
*/
package main

import "fmt"

// ───────────────────────────────────────────────────────────────
// 1. 定义结构体：type 名字 struct { 字段们 }
// ───────────────────────────────────────────────────────────────
// type 关键字用于定义【新类型】，struct 描述一组字段的集合
type Book struct {
	Title  string // 大写开头：导出字段，包外可访问
	Author string
	Pages  int
	price  float64 // 小写开头：私有字段，只有本包能访问
}

// 相同类型的字段可以合并写在一行
type Rectangle struct {
	Width, Height float64
}

// ───────────────────────────────────────────────────────────────
// 2. 嵌套结构体：字段的类型也可以是结构体
// ───────────────────────────────────────────────────────────────
type Address struct {
	City   string
	Street string
}

type Company struct {
	Name string
	Addr Address // 普通嵌套：有字段名 Addr
}

// ───────────────────────────────────────────────────────────────
// 3. 结构体嵌入（embedding）★★★ Go 替代继承的方案
// ───────────────────────────────────────────────────────────────
// 只写类型不写字段名 => "嵌入"。被嵌入类型的字段（和方法）会被【提升】，
// 外层可以直接访问，看起来就像"继承"了它们 —— 但本质是组合 + 语法糖。
type Animal struct {
	Name string
	Legs int
}

type Dog struct {
	Animal // 嵌入 Animal（注意：没有字段名！）
	Breed  string
}

// ───────────────────────────────────────────────────────────────
// 4. 结构体标签（tag）：给字段附加元信息
// ───────────────────────────────────────────────────────────────
// 字段后面的反引号字符串是 tag，最常见用途是控制 JSON 序列化（第 19 节实战）。
// 格式惯例：`键:"值"`，多个键空格分隔。库通过反射读取这些 tag。
type LoginRequest struct {
	Username string `json:"username"`           // JSON 里叫 username（小写）
	Password string `json:"password,omitempty"` // omitempty: 零值时省略该字段
	Remember bool   `json:"-"`                  // -: 序列化时忽略这个字段
}

// 工厂函数惯例：Go 没有构造函数，约定写 NewXxx 返回 *Xxx
// 在这里做参数校验、设置默认值
func NewBook(title, author string) *Book {
	return &Book{
		Title:  title,
		Author: author,
		Pages:  1, // 默认值
		price:  0,
	}
}

func main() {
	fmt.Println("══════ 1. 初始化结构体的几种方式 ══════")

	// 方式一：零值结构体 —— 所有字段都是各自类型的零值（可用状态！）
	var b1 Book
	fmt.Printf("零值: %+v\n", b1) // {Title: Author: Pages:0 price:0}

	// 方式二：字段名初始化 ★最推荐——可读、可乱序、可省略部分字段
	b2 := Book{
		Title:  "Go 程序设计语言",
		Author: "Donovan & Kernighan",
		Pages:  380, // 最后一行也要逗号
	}
	fmt.Printf("字段名式: %+v\n", b2)

	// 方式三：按顺序初始化 —— 必须按定义顺序给【全部】字段，加字段就崩，少用
	b3 := Book{"Go 语言实战", "Kennedy", 300, 59.0}
	fmt.Printf("顺序式: %+v\n", b3)

	// 方式四：工厂函数（带默认值/校验逻辑时用）
	b4 := NewBook("学习 Go", "Jon Bodner")
	fmt.Printf("工厂函数: %+v\n", *b4)

	// 读写字段：点号
	b2.Pages = 400
	fmt.Println("书名:", b2.Title, "页数:", b2.Pages)

	fmt.Println("\n══════ 2. 结构体是值类型 ══════")
	// 赋值 = 整体拷贝（所有字段逐一复制），两份互不影响
	c1 := b2
	c1.Title = "改了副本的标题"
	fmt.Println("原书还是:", b2.Title) // 没受影响
	// 想共享就用指针（第 09 节讲过）：
	pb := &b2
	pb.Title = "通过指针改标题" // 自动解引用，无需 (*pb).Title
	fmt.Println("原书变成:", b2.Title)

	// 可比较性：所有字段都可比较时，结构体可以用 == 逐字段比较
	r1 := Rectangle{3, 4}
	r2 := Rectangle{3, 4}
	fmt.Println("r1 == r2 ?", r1 == r2) // true（内容相同）
	// ⚠️ 含切片/map/函数字段的结构体不能用 ==（编译错误）

	fmt.Println("\n══════ 3. 嵌套结构体 ══════")
	comp := Company{
		Name: "Gopher 科技",
		Addr: Address{ // 嵌套字段逐层初始化
			City:   "上海",
			Street: "软件大道 1 号",
		},
	}
	fmt.Println("公司在:", comp.Addr.City) // 逐层用点号访问

	fmt.Println("\n══════ 4. 嵌入：组合代替继承 ★★★ ══════")
	d := Dog{
		Animal: Animal{Name: "旺财", Legs: 4}, // 嵌入字段的"字段名"就是类型名
		Breed:  "柴犬",
	}

	// ★ 字段提升：Animal 的字段可以当作 Dog 自己的字段直接访问
	fmt.Println("名字:", d.Name)          // 等价于 d.Animal.Name —— 像继承！
	fmt.Println("腿数:", d.Legs)          // 提升访问
	fmt.Println("完整路径:", d.Animal.Name) // 显式路径也合法
	fmt.Println("品种:", d.Breed)

	// 它不是继承的证据：
	// 1) Dog 不能赋值给 Animal 类型的变量（没有 is-a 关系，没有多态）
	//    var a Animal = d // 编译错误！
	// 2) 同名字段时外层【遮蔽】内层，需要写全路径消歧义
	// 3) 方法也会被提升（第 11 节演示），这才是嵌入的最大威力
	var a Animal = d.Animal // 想要 Animal 就显式取出嵌入的那部分
	fmt.Println("取出嵌入部分:", a)

	fmt.Println("\n══════ 5. 匿名结构体：一次性的小结构 ══════")
	// 不想专门 type 一个名字时用。常见于：测试用例表、临时聚合数据
	point := struct {
		X, Y int
	}{X: 10, Y: 20} // 定义类型的同时直接初始化
	fmt.Println("匿名结构体:", point)

	// 经典应用：表驱动测试的用例表（第 20 节真正使用）
	testCases := []struct {
		input    int
		expected string
	}{
		{1, "one"},
		{2, "two"},
	}
	for _, tc := range testCases {
		fmt.Printf("  用例: 输入 %d 期望 %q\n", tc.input, tc.expected)
	}

	fmt.Println("\n══════ 6. 结构体标签一瞥 ══════")
	req := LoginRequest{Username: "gopher", Password: "s3cret", Remember: true}
	fmt.Printf("%+v\n", req)
	fmt.Println("tag 的实际效果（JSON 序列化）在 19_stdlib 中演示")
}
