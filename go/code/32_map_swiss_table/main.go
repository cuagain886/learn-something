/* 32_map_swiss_table —— Go 1.26.4 Swiss Table 与教学探测模型。 */
package main

import "fmt"

func main() {
	t, _ := NewTable[int, string](1, HashInt)
	for i := range 20 {
		t.Set(i, fmt.Sprintf("v%d", i))
	}
	t.Delete(3)
	value, ok := t.Get(7)
	fmt.Printf("len=%d capacity=%d get(7)=%q,%v deleted(3)=%v\n", t.Len(), t.Capacity(), value, ok, func() bool { _, ok := t.Get(3); return !ok }())
	fmt.Println("教学模型用于验证探测不变量；真实 runtime 还包含 group 匹配、目录和 table 分裂。")
}
