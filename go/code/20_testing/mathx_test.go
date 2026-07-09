// mathx_test.go —— 测试文件三要素：
//  1. 文件名以 _test.go 结尾
//  2. import "testing"
//  3. 测试函数签名固定：func TestXxx(t *testing.T)（Xxx 首字母必须大写）
//
// Go 测试没有 assert 库（标准库层面）：用普通 if + t.Errorf 报告失败。
// 哲学：测试就是普通 Go 代码，无需学习新 DSL。
// （社区也常用 github.com/stretchr/testify 提供断言风格，可选）
package mathx

import (
	"errors"
	"fmt"
	"testing"
)

// ───────────────────────────────────────────────────────────────
// 1. 最简单的测试
// ───────────────────────────────────────────────────────────────
func TestAbs(t *testing.T) {
	got := Abs(-5) // 调用被测函数（同包，直接调用，连私有函数都能测）
	want := 5

	if got != want {
		// t.Errorf：标记失败并继续执行后面的检查
		// t.Fatalf：标记失败并【立即终止】本测试函数（后续检查无意义时用）
		// 报错格式惯例：函数(输入) = 实际值, want 期望值
		t.Errorf("Abs(-5) = %d, want %d", got, want)
	}
}

// ───────────────────────────────────────────────────────────────
// 2. 表驱动测试 ★★★ Go 测试的标志性风格
// ───────────────────────────────────────────────────────────────
// 把用例组织成匿名结构体切片（第 10 节学过的语法！），循环逐个跑。
// 加用例 = 加一行数据，不用复制粘贴测试逻辑。
func TestClamp(t *testing.T) {
	tests := []struct {
		name      string // 用例名（显示在输出里，方便定位）
		v, lo, hi int    // 输入
		want      int    // 期望输出
	}{
		{"区间内原样返回", 5, 0, 10, 5},
		{"小于下界取下界", -3, 0, 10, 0},
		{"大于上界取上界", 99, 0, 10, 10},
		{"恰好压线", 10, 0, 10, 10},
	}

	for _, tt := range tests {
		// t.Run 创建【子测试】：每个用例独立计数、独立报告，
		// 还能单跑某个用例：go test -run TestClamp/恰好压线
		t.Run(tt.name, func(t *testing.T) {
			got := Clamp(tt.v, tt.lo, tt.hi)
			if got != tt.want {
				t.Errorf("Clamp(%d, %d, %d) = %d, want %d",
					tt.v, tt.lo, tt.hi, got, tt.want)
			}
		})
	}
}

// ───────────────────────────────────────────────────────────────
// 3. 测试错误路径：成功与失败两个分支都要覆盖
// ───────────────────────────────────────────────────────────────
func TestAverage(t *testing.T) {
	t.Run("正常情况", func(t *testing.T) {
		got, err := Average([]int{1, 2, 3, 4})
		if err != nil {
			// 不该出错却出错 => 后续检查没意义，用 Fatalf 直接终止
			t.Fatalf("Average 意外返回错误: %v", err)
		}
		if got != 2.5 {
			t.Errorf("Average([1 2 3 4]) = %v, want 2.5", got)
		}
	})

	t.Run("空切片返回哨兵错误", func(t *testing.T) {
		_, err := Average(nil)
		// 用第 13 节学的 errors.Is 验证错误种类
		if !errors.Is(err, ErrEmptySlice) {
			t.Errorf("Average(nil) 的错误 = %v, want ErrEmptySlice", err)
		}
	})
}

// ───────────────────────────────────────────────────────────────
// 4. 基准测试：func BenchmarkXxx(b *testing.B)
// ───────────────────────────────────────────────────────────────
// 运行：go test -bench=. ./20_testing
// 框架会自动调整循环次数直到测量稳定，输出每次操作的纳秒数
func BenchmarkFib10(b *testing.B) {
	for b.Loop() { // Go 1.24+ 的基准循环写法（老写法：for i := 0; i < b.N; i++）
		Fib(10) // 被测量的操作
	}
}

func BenchmarkFib20(b *testing.B) {
	for b.Loop() {
		Fib(20) // 对比 Fib10，直观看到指数级递归的代价
	}
}

// ───────────────────────────────────────────────────────────────
// 5. 示例测试：既是文档又是测试
// ───────────────────────────────────────────────────────────────
// func ExampleXxx() 里打印输出，并用 "// Output:" 注释声明期望输出。
// go test 会真的运行它并【比对输出】；go doc 会把它展示为用法示例。
func ExampleAbs() {
	fmt.Println(Abs(-42))
	// 此函数没写 Output 注释，所以只编译不运行——保证示例代码不会烂掉
}

// 带输出断言的示例：输出不匹配会导致测试失败
// ⚠️ 注意必须用 fmt 打印（比对的是标准输出 stdout）
func ExampleClamp() {
	result := Clamp(15, 0, 10)
	fmt.Print(result)
	// Output: 10
}
