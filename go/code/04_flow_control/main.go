/*
═══════════════════════════════════════════════════════════════════

	04_flow_control —— 流程控制：if / for / switch / label

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. if 语句（条件不加括号、可带初始化语句）
 2. for —— Go 唯一的循环关键字的四种形态
 3. switch —— 默认不穿透、可以没有条件、可以 case 多值
 4. break / continue / 标签（label）/ goto

【运行】go run ./04_flow_control

【与其他语言的核心差异】
  - 没有 while、没有 do-while：全部用 for 表达
  - 条件表达式【不加圆括号】，但花括号【必须有】（哪怕只有一行）
  - switch 默认自动 break，不会像 C/Java 那样穿透到下一个 case
  - 条件必须是 bool：if x { } 中 x 不能是数字（没有"真值"概念）
*/
package main

import (
	"fmt"
	"strconv"
)

func main() {
	fmt.Println("══════ 1. if / else ══════")
	score := 87

	// 基本形式：条件不加括号，{ 必须跟在同一行
	if score >= 90 {
		fmt.Println("优秀")
	} else if score >= 60 { // else 必须和上一个 } 同一行（自动分号规则）
		fmt.Println("及格")
	} else {
		fmt.Println("不及格")
	}

	// ★ if 的初始化语句：分号前先执行一条语句，常用于"先调用、再判断"
	// 变量 n 的作用域【仅限于】这个 if/else 块内 —— 避免污染外层作用域
	if n, err := strconv.Atoi("123"); err == nil { // Atoi: 字符串转 int
		fmt.Println("转换成功，n =", n)
	} else {
		fmt.Println("转换失败:", err)
	}
	// fmt.Println(n) // 编译错误：n 在这里已经不可见
	// 这个模式在错误处理中无处不在：if err := doSomething(); err != nil {...}

	fmt.Println("\n══════ 2. for —— 唯一的循环 ══════")

	// 形态一：经典三段式 for 初始化; 条件; 后置语句 { }（同样不加括号）
	sum := 0
	for i := 1; i <= 100; i++ {
		sum += i
	}
	fmt.Println("1 加到 100 =", sum) // 5050

	// 形态二：只有条件 —— 这就是其他语言的 while！
	count := 1
	for count < 100 {
		count *= 2 // 1 -> 2 -> 4 -> ... -> 128
	}
	fmt.Println("翻倍到超过 100:", count) // 128

	// 形态三：什么都不写 —— 无限循环（等价于 while(true)），配合 break 退出
	attempts := 0
	for {
		attempts++
		if attempts >= 3 {
			break // 跳出当前循环
		}
	}
	fmt.Println("尝试次数:", attempts) // 3

	// 形态四：for range —— 遍历集合（切片/数组/map/字符串/channel/整数）
	fruits := []string{"苹果", "香蕉", "橙子"} // 切片，第 06 节细讲
	for i, fruit := range fruits {       // 返回 (索引, 元素值)
		fmt.Printf("  fruits[%d] = %s\n", i, fruit)
	}
	for _, fruit := range fruits { // 不需要索引就用 _ 丢弃
		_ = fruit
	}
	for i := range fruits { // 只要索引可以省略第二个变量
		_ = i
	}
	// Go 1.22+ 还能直接 range 一个整数：i 依次取 0,1,2
	for i := range 3 {
		fmt.Println("  range 整数:", i)
	}

	// continue：跳过本轮循环剩余部分，进入下一轮
	fmt.Print("  1~10 中的奇数: ")
	for i := 1; i <= 10; i++ {
		if i%2 == 0 {
			continue // 偶数跳过
		}
		fmt.Print(i, " ")
	}
	fmt.Println()

	fmt.Println("\n══════ 3. switch ══════")

	// 基本用法：⚠️ 每个 case 执行完【自动 break】，不会穿透！
	day := 3
	switch day {
	case 1, 2, 3, 4, 5: // ★ 一个 case 可以匹配多个值（逗号分隔）
		fmt.Println("工作日")
	case 6, 7:
		fmt.Println("周末")
	default: // default 可放任意位置，匹配不到任何 case 时执行
		fmt.Println("非法的日期")
	}

	// switch 也支持初始化语句（和 if 一样）
	switch hour := 14; { // 注意：这里 switch 后面没有判断对象！
	// 无表达式的 switch 等价于 switch true，case 写【条件表达式】，
	// 是比一长串 if/else-if 更清晰的写法
	case hour < 12:
		fmt.Println("上午好")
	case hour < 18:
		fmt.Println("下午好")
	default:
		fmt.Println("晚上好")
	}

	// fallthrough：确实需要穿透到下一个 case 时显式写出来（很少用）
	switch grade := 'B'; grade {
	case 'A':
		fmt.Println("奖学金 +1000")
		fallthrough // 强制继续执行下一个 case（不判断其条件！）
	case 'B':
		fmt.Println("奖学金 +500")
		fallthrough
	case 'C':
		fmt.Println("继续努力")
	case 'D':
		fmt.Println("需要补考") // 不会执行：fallthrough 链到 C 就停了
	}

	// type switch（按类型分支）是 switch 的重要变体，放在第 12 节接口部分讲

	fmt.Println("\n══════ 4. 标签 label：控制嵌套循环 ══════")
	// break/continue 默认只作用于【最内层】循环。
	// 想直接跳出外层循环，给外层循环贴一个标签，break 标签名 即可。
	// （其他语言往往要用 flag 变量或封装函数才能做到）
outer: // 标签：一个标识符 + 冒号，放在 for 之前
	for i := 1; i <= 3; i++ {
		for j := 1; j <= 3; j++ {
			if i*j > 4 {
				fmt.Printf("  在 i=%d j=%d 处跳出全部循环\n", i, j)
				break outer // 直接结束外层 for，而不只是内层
			}
			fmt.Printf("  i=%d j=%d 积=%d\n", i, j, i*j)
		}
	}

	// goto：无条件跳转到标签处。Go 保留了它，但实际代码中几乎不用，
	// 偶见于跳到函数末尾的统一清理逻辑。知道存在即可。
	i := 0
loop:
	if i < 3 {
		fmt.Println("  goto 循环 i =", i)
		i++
		goto loop // 跳回 loop 标签处（演示用，请勿模仿）
	}

	fmt.Println("\n══════ 5. ⚠️ 循环变量陷阱（新旧版本差异）══════")
	// Go 1.22 起：for 循环的循环变量【每轮迭代都是新变量】。
	// 老版本(<=1.21)中所有迭代共享同一个变量，闭包/goroutine 捕获它
	// 会拿到最后一轮的值——这曾是 Go 最著名的坑，现已在语言层面修复。
	funcs := []func(){} // 函数切片
	for _, v := range []int{1, 2, 3} {
		funcs = append(funcs, func() { fmt.Print(v, " ") }) // 闭包捕获 v
	}
	fmt.Print("  闭包输出: ")
	for _, f := range funcs {
		f() // Go 1.22+: 输出 1 2 3（老版本会输出 3 3 3）
	}
	fmt.Println()
}
