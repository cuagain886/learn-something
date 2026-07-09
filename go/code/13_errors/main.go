/*
═══════════════════════════════════════════════════════════════════

	13_errors —— 错误处理：错误是值，不是异常

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. error 接口与 (值, error) 返回模式
 2. 创建错误：errors.New / fmt.Errorf
 3. 错误包装（%w）与 errors.Is / errors.As ——现代 Go 错误处理三件套
 4. 自定义错误类型
 5. panic / recover：什么时候才轮到它们

【运行】go run ./13_errors

【设计哲学】

	Go 没有 try/catch。错误就是普通的【返回值】，调用方必须当场面对：
	要么处理，要么加上下文继续往上传。代价是满屏 if err != nil，
	收益是：每个可能失败的地方在代码里清晰可见，没有隐形的跳转路径。
*/
package main

import (
	"errors"
	"fmt"
	"os"
	"strconv"
)

// ───────────────────────────────────────────────────────────────
// 1. error 是一个普通接口，定义在标准库：
//        type error interface { Error() string }
//    任何有 Error() string 方法的类型都是 error。
// ───────────────────────────────────────────────────────────────

// 哨兵错误（sentinel error）：包级预定义错误变量，惯例以 Err 开头命名。
// 调用方可用 errors.Is 判断"是不是这一种错"（标准库如 os.ErrNotExist 同款做法）
var ErrInsufficientBalance = errors.New("余额不足")

// withdraw 取款：演示 (结果, error) 模式与哨兵错误
func withdraw(balance, amount float64) (float64, error) {
	if amount <= 0 {
		// fmt.Errorf：带格式化的错误信息（错误信息惯例：小写开头、不带标点）
		return balance, fmt.Errorf("非法金额 %.2f", amount)
	}
	if amount > balance {
		return balance, ErrInsufficientBalance // 返回哨兵错误
	}
	return balance - amount, nil // 成功：error 位置返回 nil
}

// ───────────────────────────────────────────────────────────────
// 2. 自定义错误类型：当错误需要携带【结构化数据】时
// ───────────────────────────────────────────────────────────────
type ValidationError struct {
	Field string // 哪个字段出错
	Value any    // 错的值是什么
}

// 实现 Error() string => ValidationError 就是一个 error
func (e *ValidationError) Error() string {
	return fmt.Sprintf("字段 %q 的值 %v 不合法", e.Field, e.Value)
}

func validateAge(age int) error {
	if age < 0 || age > 150 {
		return &ValidationError{Field: "age", Value: age} // 返回自定义错误
	}
	return nil
}

// ───────────────────────────────────────────────────────────────
// 3. 错误包装：每一层加上自己的上下文，形成"错误链"
// ───────────────────────────────────────────────────────────────
// 业务函数常常层层调用，惯用法是用 fmt.Errorf + %w 动词包装底层错误：
// 这样既添加了上下文，又保留了原始错误（可被 Is/As 检查）
func loadConfig(path string) error {
	_, err := os.ReadFile(path) // 读文件失败会返回 *PathError
	if err != nil {
		// %w（wrap）：把 err 包进新错误里，形成链：新错误 -> err
		return fmt.Errorf("加载配置 %s 失败: %w", path, err)
	}
	return nil
}

func main() {
	fmt.Println("══════ 1. 错误处理的标准姿势 ══════")
	balance := 100.0

	// ★ 标准范式：调用 -> 立刻判 err -> 错误路径先返回/处理（early return）
	newBalance, err := withdraw(balance, 30)
	if err != nil {
		fmt.Println("取款失败:", err)
	} else {
		fmt.Println("取款成功，余额:", newBalance)
	}

	// 失败案例
	_, err = withdraw(balance, 99999)
	if err != nil {
		fmt.Println("取款失败:", err) // 余额不足
	}

	fmt.Println("\n══════ 2. errors.Is：判断错误链中是否有某个哨兵错误 ══════")
	_, err = withdraw(100, 200)
	// ⚠️ 不要用 err == ErrInsufficientBalance 直接比较——
	// 一旦中间层用 %w 包装过，== 就失效了；errors.Is 会【沿着链】逐层找
	if errors.Is(err, ErrInsufficientBalance) {
		fmt.Println("识别出'余额不足'，引导用户充值")
	}

	fmt.Println("\n══════ 3. errors.As：从错误链中取出特定类型 ══════")
	err = validateAge(-5)
	// As：在链中找 *ValidationError 类型，找到就填充到 ve 并返回 true
	var ve *ValidationError
	if errors.As(err, &ve) { // 注意传的是 &ve（指针的指针）
		// 取到具体类型后，可以访问其结构化字段做精细处理
		fmt.Printf("校验错误 -> 字段: %s, 非法值: %v\n", ve.Field, ve.Value)
	}

	fmt.Println("\n══════ 4. 错误包装链实战 ══════")
	err = loadConfig("不存在的文件.yaml")
	fmt.Println("完整错误链:", err)
	// 输出形如：加载配置 xxx 失败: open xxx: The system cannot find...
	// 链上每层都加了上下文，根因也没丢：
	fmt.Println("根因是'文件不存在'吗?", errors.Is(err, os.ErrNotExist)) // true！
	// errors.Unwrap 可手动剥一层（一般用 Is/As 就够了）
	fmt.Println("剥一层后:", errors.Unwrap(err))

	fmt.Println("\n══════ 5. panic / recover：留给真正的灾难 ══════")
	// panic：立刻中断正常流程，逐层执行 defer 往上冒泡，到顶则崩溃打印堆栈。
	// 【何时 panic】只用于"程序写错了"的不可恢复场景：
	//    数组越界、解引用 nil、初始化必需资源失败……
	// 【何时 error】一切"预期内可能失败"的事：文件不存在、网络超时、
	//    用户输入非法…… ★ 99% 的情况用 error，不要拿 panic 当异常机制用！

	// recover：只能在 defer 的函数里调用，捕获当前 goroutine 的 panic
	result := safeDivide(10, 2)
	fmt.Println("10/2 =", result)
	result = safeDivide(10, 0) // 内部 panic 被 recover 接住，不会崩溃
	fmt.Println("10/0 安全返回 =", result)
	fmt.Println("程序还活着，继续执行")

	fmt.Println("\n══════ 6. 实战小结 ══════")
	// 综合演练：解析一批字符串，逐个处理错误而不是中断整批
	inputs := []string{"42", "abc", "100", ""}
	for _, in := range inputs {
		n, err := strconv.Atoi(in)
		if err != nil {
			// 真实项目这里会记日志；注意错误已含上下文，直接打印即可
			fmt.Printf("  跳过非法输入 %q: %v\n", in, err)
			continue // 单条失败不影响整批 —— 错误是值，处理方式由你掌控
		}
		fmt.Printf("  解析成功: %d\n", n)
	}
}

// safeDivide 演示 defer + recover 兜底：把 panic 转化为安全返回
// （注意：这只是演示。除零本应事前 if 判断，而不是靠 recover）
func safeDivide(a, b int) (result int) { // 命名返回值：recover 后能改返回值
	defer func() {
		// recover() 返回 panic 传入的值；没有 panic 时返回 nil
		if r := recover(); r != nil {
			fmt.Println("  捕获到 panic:", r)
			result = 0 // 通过命名返回值给出兜底结果
		}
	}()
	return a / b // b 为 0 时触发运行时 panic: integer divide by zero
}
