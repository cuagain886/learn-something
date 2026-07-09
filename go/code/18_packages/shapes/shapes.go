// Package shapes 演示如何编写一个【库包】（非 main 包）。
//
// 包声明上方的这段注释是"包文档"，惯例以 "Package 包名" 开头，
// go doc ./18_packages/shapes 或 pkg.go.dev 会展示它。
//
// 【包的基本规则】
//   - 一个目录 = 一个包；目录下所有 .go 文件的 package 声明必须一致
//   - 包名惯例：简短、小写、不用下划线（shapes 而不是 my_shapes_pkg）
//   - 包名通常和目录名相同（不强制，但不同会让使用者困惑）
//   - main 包 => 可执行程序；其他名字 => 库，被 import 使用
package shapes

import (
	"errors"
	"math"
)

// ───────────────────────────────────────────────────────────────
// 可见性：首字母大小写决定一切（Go 唯一的访问控制机制）
// ───────────────────────────────────────────────────────────────

// Pi 大写开头：【导出】，包外可以用 shapes.Pi 访问。
// 导出的标识符必须写文档注释，惯例以标识符名开头（golint 规范）。
const Pi = math.Pi

// defaultPrecision 小写开头：【未导出】，只有 shapes 包内部能用。
// 外部写 shapes.defaultPrecision 是编译错误。
const defaultPrecision = 2

// ErrNegativeSize 哨兵错误：导出给调用方做 errors.Is 判断。
// 错误变量的命名惯例：Err 前缀。
var ErrNegativeSize = errors.New("shapes: 尺寸不能为负数")

// Rect 导出的结构体。注意字段也各自受大小写规则约束：
type Rect struct {
	Width  float64 // 导出字段：包外可读写
	Height float64
	label  string // 未导出字段：包外不可见，只能通过本包提供的方法访问
}

// NewRect 是 Rect 的工厂函数（Go 的"构造函数"惯例：NewXxx）。
// 在这里集中做参数校验 —— 这是未导出字段 + 工厂函数组合的价值：
// 外部无法绕过校验直接拼一个非法对象。
func NewRect(w, h float64) (*Rect, error) {
	if w < 0 || h < 0 {
		return nil, ErrNegativeSize
	}
	return &Rect{Width: w, Height: h, label: "矩形"}, nil
}

// Area 返回矩形面积。
func (r *Rect) Area() float64 {
	return r.Width * r.Height
}

// Label 读取未导出字段的"getter"。
// Go 惯例：getter 不叫 GetLabel，就叫 Label。
func (r *Rect) Label() string {
	return r.label
}

// round 未导出的内部辅助函数：包外不可见，是包的实现细节。
func round(v float64, precision int) float64 {
	p := math.Pow(10, float64(precision))
	return math.Round(v*p) / p
}

// CircleArea 计算圆面积（保留 2 位小数），内部使用未导出的 round。
func CircleArea(radius float64) (float64, error) {
	if radius < 0 {
		return 0, ErrNegativeSize
	}
	return round(Pi*radius*radius, defaultPrecision), nil
}
