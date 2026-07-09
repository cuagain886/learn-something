// Package mathx 是被测试的示例库包。
//
// 本目录演示 Go 自带的测试体系：
//   - 测试文件命名：xxx_test.go（构建普通程序时被自动排除）
//   - 测试与被测代码放在【同一目录】，这是 Go 的惯例
//   - 运行：go test ./20_testing            （静默模式，只报失败）
//     go test -v ./20_testing          （-v 显示每个用例）
//     go test -run TestAbs ./20_testing（只跑名字匹配的测试）
//     go test -cover ./20_testing      （顺带统计覆盖率）
//     go test -bench=. ./20_testing    （运行基准测试）
package mathx

import "errors"

// Abs 返回整数的绝对值。
func Abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// Clamp 把 v 限制在 [lo, hi] 区间内：小于 lo 返回 lo，大于 hi 返回 hi。
func Clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// ErrEmptySlice 输入为空切片时返回的哨兵错误。
var ErrEmptySlice = errors.New("mathx: 切片为空")

// Average 计算整数切片的平均值；空切片返回 ErrEmptySlice。
func Average(nums []int) (float64, error) {
	if len(nums) == 0 {
		return 0, ErrEmptySlice
	}
	sum := 0
	for _, n := range nums {
		sum += n
	}
	return float64(sum) / float64(len(nums)), nil
}

// Fib 返回第 n 个斐波那契数（递归实现，故意低效——给基准测试当靶子）。
func Fib(n int) int {
	if n < 2 {
		return n
	}
	return Fib(n-1) + Fib(n-2)
}
