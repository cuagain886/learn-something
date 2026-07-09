/*
═══════════════════════════════════════════════════════════════════

	09_pointers —— 指针：值传递世界里的"修改原件"手段

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. 指针基础：& 取地址、* 解引用
 2. Go 指针 vs C 指针：安全得多（无指针运算、有 GC、自动判逃逸）
 3. 值传递语义：为什么函数改不动你的变量
 4. new 函数、nil 指针、何时该用指针

【运行】go run ./09_pointers

【先放宽心】

	Go 的指针没有 C 那么吓人：
	- ✅ 不能做指针运算（p++ 非法），不会越界乱指
	- ✅ 有垃圾回收，不用手动 free，没有悬垂指针
	- ✅ 可以安全返回局部变量的地址（编译器自动把它分配到堆上，叫"逃逸分析"）
	- 它本质上就是 Java/Python 里"对象引用"的显式版本
*/
package main

import "fmt"

// User 演示用的结构体（结构体语法第 10 节细讲，这里只需知道它是一组字段）
type User struct {
	Name string
	Age  int
}

func main() {
	fmt.Println("══════ 1. 取地址 & 与解引用 * ══════")
	x := 42

	// &x：取变量 x 的内存地址，得到一个 *int 类型（"指向 int 的指针"）
	p := &x
	fmt.Println("x 的值   :", x)    // 42
	fmt.Println("x 的地址 :", p)     // 类似 0xc000012345
	fmt.Printf("p 的类型 : %T\n", p) // *int

	// *p：解引用 —— 顺着指针找到它指向的那个变量
	fmt.Println("*p（读）:", *p)       // 42，读出 x 的值
	*p = 100                        // 通过指针【写】：x 被改成 100
	fmt.Println("通过 *p 修改后 x =", x) // 100

	// 指针的零值是 nil
	var q *int                // 只声明不初始化 => nil
	fmt.Println("nil 指针:", q) // <nil>
	// fmt.Println(*q) // ⚠️ 解引用 nil 指针会 panic（相当于 NPE），先判 nil！
	if q != nil {
		fmt.Println(*q)
	}

	fmt.Println("\n══════ 2. 为什么需要指针：Go 一切皆值传递 ══════")
	// Go 的函数参数【永远是拷贝】。传 int 拷贝 int，传结构体拷贝整个结构体。
	// 函数内部修改的是副本，调用者的原变量纹丝不动：
	n := 10
	failToModify(n)                       // 把 n 的【副本】传进去
	fmt.Println("failToModify 之后 n =", n) // 仍然是 10！

	// 想让函数修改原变量 => 把变量的【地址】传进去
	modify(&n)                          // 传 n 的地址
	fmt.Println("modify(&n) 之后 n =", n) // 999，改到原件了

	// 经典应用：交换两个变量（虽然 Go 里 a,b = b,a 更简单，这里仅演示指针）
	a, b := 1, 2
	swap(&a, &b)
	fmt.Println("交换后 a =", a, "b =", b) // 2 1

	fmt.Println("\n══════ 3. 结构体与指针（实际开发的主战场）══════")
	u := User{Name: "小明", Age: 25} // User 定义在文件顶部

	// 传值：函数拿到整个结构体的副本，改了白改，而且大结构体拷贝费内存
	birthdayByValue(u)
	fmt.Println("传值后:", u.Age) // 25，没变

	// 传指针：函数操作原件 ★这是修改结构体的标准方式
	birthdayByPointer(&u)
	fmt.Println("传指针后:", u.Age) // 26，变了！

	// ★ 语法糖：结构体指针访问字段【不需要】显式解引用
	up := &u
	up.Age = 30                    // 自动等价于 (*up).Age = 30，不用像 C 那样写 ->
	fmt.Println("通过指针改字段:", u.Age) // 30

	fmt.Println("\n══════ 4. 创建指针的几种方式 ══════")
	// 方式一：对已有变量取地址（最常见）
	v := 3.14
	p1 := &v

	// 方式二：new(T) —— 分配一个 T 类型的零值，返回 *T
	p2 := new(int) // p2 指向一个值为 0 的 int
	*p2 = 7
	fmt.Println("*p1 =", *p1, " *p2 =", *p2)

	// 方式三：取结构体字面量的地址（实际代码里最常见的形式）
	p3 := &User{Name: "小红", Age: 23} // 一步到位：创建并取址
	fmt.Println("p3 =", p3)          // &{小红 23}（fmt 打印指针指向的结构体会加 &）
	fmt.Println("*p3 =", *p3)        // {小红 23}

	// ★ 返回局部变量的地址是安全的！（C 程序员最惊讶的一点）
	// 编译器发现地址"逃逸"出函数，会自动把变量分配在堆上，由 GC 管理
	freshUser := newUser("小刚")
	fmt.Println("工厂函数返回的指针:", freshUser)

	fmt.Println("\n══════ 5. 什么时候用指针？（经验法则）══════")
	fmt.Println(`  用指针（*T）当：
    1. 函数需要修改调用者的变量
    2. 结构体较大，避免每次传参都整个拷贝
    3. 需要表达"可能不存在"——nil 可以当"无值"信号（如数据库查不到）
  用值（T）当：
    1. 小型只读数据（int、小结构体）——拷贝比共享更安全也常常更快
    2. 希望天然的不可变性（副本怎么改都影响不到别人）
  Go 没有的东西：
    ✗ 指针运算 p+1（编译错误）   ✗ 手动释放 free
    ✗ -> 操作符（统一用 . ）     ✗ 二级指针的常见场景（极少需要 **T）`)
}

// failToModify 接收 int 的副本，修改副本对外界无效
func failToModify(n int) {
	n = 999 // 只改了自己的局部副本
}

// modify 接收 *int（地址），通过解引用修改调用者的变量
func modify(n *int) {
	*n = 999 // 顺着地址改到原变量
}

// swap 通过指针交换两个 int
func swap(a, b *int) {
	*a, *b = *b, *a // 多重赋值 + 解引用
}

// birthdayByValue 值参数：拷贝整个 User，修改无效
func birthdayByValue(u User) {
	u.Age++ // 改的是副本
}

// birthdayByPointer 指针参数：修改原结构体 ★实际开发标准写法
func birthdayByPointer(u *User) {
	u.Age++ // 语法糖：等价 (*u).Age++
}

// newUser 工厂函数：返回局部变量的地址 —— 完全安全（逃逸分析）
// 这是 Go 构造对象最常见的模式之一（"构造函数"惯例命名为 NewXxx）
func newUser(name string) *User {
	u := User{Name: name, Age: 18} // 局部变量
	return &u                      // 返回它的地址：编译器自动让 u 分配到堆上
}
