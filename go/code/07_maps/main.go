/*
═══════════════════════════════════════════════════════════════════

	07_maps —— 映射（哈希表）

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. map 的创建、增删查改
 2. comma-ok 惯用法：区分"值为零"和"键不存在"
 3. 遍历无序性、map 作集合（Set）使用
 4. map 的引用语义与 nil map 陷阱

【运行】go run ./07_maps

【与其他语言的对照】
  - map ≈ Python 的 dict / Java 的 HashMap / JS 的对象(Map)
  - 键必须是【可比较】类型（数值/字符串/布尔/指针/数组/不含切片的结构体），
    切片、map、函数不能当键
  - Go 没有内置 Set 类型，惯用 map[T]bool 或 map[T]struct{} 代替
*/
package main

import (
	"fmt"
	"maps" // Go 1.21+ 官方 map 工具包
	"sort"
)

func main() {
	fmt.Println("══════ 1. 创建 map ══════")
	// 方式一：map 字面量。语法 map[键类型]值类型{ 键: 值, ... }
	ages := map[string]int{
		"小明": 25,
		"小红": 23,
		"小刚": 27, // ⚠️ 多行字面量最后一项也必须带逗号（自动分号规则所致）
	}
	fmt.Println("ages =", ages)

	// 方式二：make 创建空 map（可选预估容量，减少扩容）
	scores := make(map[string]float64, 10)
	scores["语文"] = 88.5 // 直接用 键 赋值即可插入
	scores["数学"] = 92.0
	fmt.Println("scores =", scores)

	// ⚠️ 陷阱：只声明不初始化的 map 是 nil map
	var nilMap map[string]int
	fmt.Println("nil map 读取安全:", nilMap["任意键"]) // 读 => 返回零值，OK
	// nilMap["键"] = 1 // ⚠️ 写入 nil map 会 panic！必须先 make 或用字面量

	fmt.Println("\n══════ 2. 增删查改 ══════")
	ages["小李"] = 30                      // 增：键不存在则插入
	ages["小明"] = 26                      // 改：键已存在则覆盖
	fmt.Println("小明现在", ages["小明"], "岁") // 查：用 [键]

	delete(ages, "小刚") // 删：内置函数 delete(map, 键)；键不存在也不报错
	fmt.Println("删除小刚后:", ages)
	fmt.Println("当前人数:", len(ages)) // len 返回键值对数量

	fmt.Println("\n══════ 3. comma-ok：判断键是否存在 ★必须掌握 ══════")
	// 直接取值时，键不存在会返回【值类型的零值】，无法区分两种情况：
	//   "键存在且值恰好是 0"  vs  "键根本不存在"
	fmt.Println("不存在的人的年龄:", ages["路人甲"]) // 0 —— 有歧义！

	// 解决：取值时接收第二个返回值 ok（bool），表示键是否存在
	age, ok := ages["小红"]
	if ok {
		fmt.Println("小红存在，年龄", age)
	}
	// 惯用写法：和 if 初始化语句结合，一行搞定
	if age, ok := ages["路人甲"]; ok {
		fmt.Println("找到了:", age)
	} else {
		fmt.Println("查无此人（ok =", ok, "）")
	}

	fmt.Println("\n══════ 4. 遍历：顺序是随机的！ ══════")
	// ⚠️ Go 故意把 map 的遍历顺序随机化（每次运行都不同），
	// 防止开发者依赖未定义的顺序。需要有序就先把键取出来排序。
	for name, a := range ages { // range map 返回 (键, 值)
		fmt.Printf("  %s -> %d\n", name, a)
	}

	// 按键有序遍历的惯用法：收集键 -> 排序 -> 按序访问
	keys := make([]string, 0, len(ages)) // 预分配容量
	for name := range ages {             // 只要键时可省略第二个变量
		keys = append(keys, name)
	}
	sort.Strings(keys) // 字符串切片排序
	fmt.Println("  ── 按键排序后 ──")
	for _, name := range keys {
		fmt.Printf("  %s -> %d\n", name, ages[name])
	}

	fmt.Println("\n══════ 5. map 是引用语义 ══════")
	// 把 map 赋值给新变量 / 传参，传的是同一张哈希表的"句柄"，
	// 任何一方修改，所有人可见（和切片共享底层数组同理）
	m1 := map[string]int{"a": 1}
	m2 := m1                    // m2 和 m1 指向同一张表
	m2["b"] = 2                 // 通过 m2 添加
	fmt.Println("m1 也看到了:", m1) // map[a:1 b:2]

	// 需要独立副本时用 maps.Clone（Go 1.21+）
	m3 := maps.Clone(m1)
	m3["c"] = 3
	fmt.Println("克隆后互不影响: m1 =", m1, " m3 =", m3)
	// maps.Equal 比较两个 map 内容是否相同（map 不能用 == 比较）
	fmt.Println("m1 与 m3 相等?", maps.Equal(m1, m3)) // false

	fmt.Println("\n══════ 6. 惯用法：用 map 实现 Set 和计数器 ══════")
	// Set（集合）：值用空结构体 struct{}{}，不占内存
	seen := make(map[string]struct{})
	words := []string{"go", "java", "go", "rust", "go"}
	for _, w := range words {
		seen[w] = struct{}{} // 加入集合（重复加无副作用）
	}
	_, exists := seen["go"] // 判断是否在集合中
	fmt.Println("集合大小:", len(seen), " 包含 go?", exists)

	// 计数器：值类型用 int，零值特性让代码异常简洁
	counter := make(map[string]int)
	for _, w := range words {
		counter[w]++ // ★ 键不存在时取出零值 0，加 1 后存回 —— 无需判断存在性
	}
	fmt.Println("词频统计:", counter) // map[go:3 java:1 rust:1]

	// 值为切片的 map：分组（group by）惯用法
	groups := make(map[int][]string) // 按名字长度分组
	for _, w := range words {
		groups[len(w)] = append(groups[len(w)], w) // nil 切片可直接 append
	}
	fmt.Println("按长度分组:", groups)

	// ⚠️ 陷阱：map 的元素不可寻址，不能直接修改"值为结构体"的字段
	type Point struct{ X, Y int }
	pts := map[string]Point{"origin": {0, 0}}
	// pts["origin"].X = 10 // 编译错误！map 元素可能因扩容搬家，禁止取址
	p := pts["origin"] // 正确做法 1：取出 -> 改 -> 放回
	p.X = 10
	pts["origin"] = p
	fmt.Println("修改后:", pts)
	// 正确做法 2：值类型用指针 map[string]*Point，可直接 pts["k"].X = 10
}
