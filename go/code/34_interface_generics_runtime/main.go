/* 34_interface_generics_runtime —— eface/iface、泛型字典与去虚拟化。 */
package main

import "fmt"

func main() {
	values := []int{1, 2, 3, 4}
	var p *int
	reflected, _ := SumViaReflect(values)
	fmt.Printf("concrete=%d generic=%d interface=%d reflect=%d typed-nil=%v\n", CallConcrete(values), CallGeneric(values), CallInterface(IntValues(values)), reflected, IsTypedNil(p))
	fmt.Println("结合 -gcflags='-m=2'、nm 和 objdump 判断内联/去虚拟化，不背固定汇编。")
}
