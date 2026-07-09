/*
═══════════════════════════════════════════════════════════════════

	06_arrays_slices —— 数组与切片（Go 最重要的数据结构）

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. 数组（array）：定长、值类型 —— 实际很少直接用
 2. 切片（slice）：变长、引用底层数组 —— 日常 99% 用它
 3. len/cap、make、append、copy
 4. 切片的底层结构与共享陷阱（高频面试题 + 高频 bug 来源）

【运行】go run ./06_arrays_slices

【与其他语言的对照】
  - 切片 ≈ Python 的 list / Java 的 ArrayList，但它只是"底层数组的视图"，
    理解这一点是避开各种坑的关键
  - 切片表达式 s[1:3] 和 Python 切片类似，但【不支持负索引】、没有步长
*/
package main

import (
	"fmt"
	"slices" // Go 1.21+ 官方切片工具包：排序、查找、比较等
)

func main() {
	fmt.Println("══════ 1. 数组：定长、值类型 ══════")
	// 数组的【长度是类型的一部分】：[3]int 和 [4]int 是两个不同类型！
	var arr [3]int                               // 声明长度为 3 的 int 数组，元素全是零值 0
	arr[0] = 10                                  // 下标访问，越界会 panic（运行时崩溃）
	fmt.Println("arr =", arr, " 长度 =", len(arr)) // [10 0 0] 3

	// 数组字面量
	primes := [5]int{2, 3, 5, 7, 11}   // 指定长度
	auto := [...]string{"a", "b", "c"} // [...] 让编译器数个数 => [3]string
	fmt.Println(primes, auto)

	// ⚠️ 数组是【值类型】：赋值、传参都会完整拷贝整个数组！
	copied := primes                                      // 拷贝出一份全新的数组
	copied[0] = 999                                       // 修改副本
	fmt.Println("原数组没变:", primes[0], " 副本变了:", copied[0]) // 2 999
	// 这和 C 的数组（退化为指针）、Java 的数组（引用）都不同！
	// 因为这个拷贝语义 + 定长限制，Go 代码中很少直接用数组，都用切片。

	fmt.Println("\n══════ 2. 切片：变长、共享底层数组 ══════")
	// 切片字面量：和数组的唯一区别是 [] 里不写长度
	nums := []int{1, 2, 3} // 类型是 []int
	fmt.Println("nums =", nums)

	// 切片的内部结构（理解一切行为的钥匙）：
	//   type slice struct {
	//       ptr *元素   // 指向底层数组中第一个可见元素
	//       len int     // 长度：可以访问的元素个数  -> len()
	//       cap int     // 容量：从 ptr 到底层数组末尾的格子数 -> cap()
	//   }
	// 切片本身只是这个小小的"三元组"，拷贝切片很廉价，
	// 但两个切片可能【指向同一个底层数组】！

	// 用 make 创建切片：make([]类型, 长度, 容量)
	s := make([]int, 3, 8) // 长度 3（元素是 0,0,0），容量 8
	fmt.Printf("make 出的切片: %v  len=%d cap=%d\n", s, len(s), cap(s))

	// nil 切片：声明不初始化的切片是 nil，但 len/cap/append/range 都安全！
	var empty []int
	fmt.Println("nil 切片:", empty == nil, " len =", len(empty)) // true 0
	// ⚠️ 只有按下标读写 nil 切片才会 panic

	fmt.Println("\n══════ 3. append：追加元素（最常用操作）══════")
	var list []int // 从 nil 切片开始积累元素是惯用法
	for i := 1; i <= 5; i++ {
		// append 把元素加到末尾并【返回新切片】，必须接收返回值！
		// 容量不够时 append 会分配一块更大的底层数组并搬迁数据
		list = append(list, i*10)
		fmt.Printf("  append 后: %v  len=%d cap=%d\n", list, len(list), cap(list))
		// 观察输出：cap 不够时大约按 2 倍扩容（小切片时）
	}
	list = append(list, 60, 70) // 一次追加多个
	more := []int{80, 90}
	list = append(list, more...) // 追加另一个切片要用 ... 展开
	fmt.Println("最终:", list)

	fmt.Println("\n══════ 4. 切片表达式 s[low:high] ══════")
	letters := []string{"a", "b", "c", "d", "e"}
	// 半开区间 [low, high)：包含 low，不包含 high（和 Python 一致）
	fmt.Println("letters[1:3] =", letters[1:3]) // [b c]
	fmt.Println("letters[:2]  =", letters[:2])  // [a b]   省略 low 默认 0
	fmt.Println("letters[3:]  =", letters[3:])  // [d e]   省略 high 默认 len
	fmt.Println("letters[:]   =", letters[:])   // 整个切片的视图
	// ⚠️ 不支持负索引！letters[-1] 是编译错误，取末尾要写 letters[len(letters)-1]
	fmt.Println("最后一个元素:", letters[len(letters)-1])

	fmt.Println("\n══════ 5. ⚠️ 大陷阱：切片共享底层数组 ══════")
	base := []int{1, 2, 3, 4, 5}
	view := base[1:4]                            // view 和 base 共享同一个底层数组！
	fmt.Println("base =", base, " view =", view) // [1 2 3 4 5] [2 3 4]

	view[0] = 999                         // 修改 view 的第 0 个元素……
	fmt.Println("修改 view 后 base =", base) // base 也变了！[1 999 3 4 5]

	// 更隐蔽的版本：append 没触发扩容时，写穿到共享数组
	a := []int{1, 2, 3, 4, 5}
	b := a[:2]                        // b: [1 2]，但 cap(b)=5，后面还有 3 个格子
	b = append(b, 777)                // 容量够 => 直接写入底层数组第 3 格……
	fmt.Println("a 被 append 改写了:", a) // [1 2 777 4 5] ⚠️
	// 解法一：copy 出独立副本
	safe := make([]int, 2)
	copy(safe, a[:2])        // copy(目标, 源)，返回拷贝的元素个数
	safe = append(safe, 888) // 此时操作的是独立数组，a 不受影响
	fmt.Println("用 copy 后 a =", a, " safe =", safe)
	// 解法二：完整切片表达式 s[low:high:max] 限制容量，强迫 append 扩容
	c := a[:2:2]       // len=2, cap=2 —— 容量被钉死
	c = append(c, 999) // 容量不够 => 分配新数组，不再影响 a
	fmt.Println("限容后 a =", a, " c =", c)

	fmt.Println("\n══════ 6. 二维切片与常用工具 ══════")
	// 二维切片 = 切片的切片，每行可以不等长（锯齿状）
	grid := [][]int{
		{1, 2, 3},
		{4, 5},
		{6},
	}
	for i, row := range grid {
		fmt.Printf("  第 %d 行: %v\n", i, row)
	}

	// slices 包（Go 1.21+）：常用算法都不用自己写了
	data := []int{5, 2, 8, 1, 9}
	slices.Sort(data)                                // 原地升序排序
	fmt.Println("排序后:", data)                        // [1 2 5 8 9]
	fmt.Println("是否包含 8:", slices.Contains(data, 8)) // true
	fmt.Println("8 的下标:", slices.Index(data, 8))     // 3
	fmt.Println("最大值:", slices.Max(data))            // 9
	idx, found := slices.BinarySearch(data, 5)       // 二分查找（要求已排序）
	fmt.Println("二分找 5: 下标 =", idx, "找到 =", found)
	rev := slices.Clone(data) // 克隆出独立副本
	slices.Reverse(rev)       // 原地反转
	fmt.Println("反转副本:", rev, " 原数据没动:", data)
	// ⚠️ 切片不能用 == 比较（只能和 nil 比），要用 slices.Equal
	fmt.Println("内容相等?", slices.Equal(data, []int{1, 2, 5, 8, 9})) // true
}
