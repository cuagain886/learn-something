/*
25_reflect_unsafe —— 反射、泛型、内存布局与 unsafe 边界

【本节学什么】
 1. addressable、settable 与反射修改值的前提
 2. 泛型、反射和直接代码各自适合解决什么问题
 3. 结构体对齐、padding、Sizeof/Alignof/Offsetof
 4. 零拷贝为什么必须同时证明生命周期和不可变性

【运行】

	go run ./25_reflect_unsafe
	go test -race ./25_reflect_unsafe
	go test -gcflags=all=-d=checkptr=2 ./25_reflect_unsafe
	go test -run='^$' -bench=. -benchmem ./25_reflect_unsafe
*/
package main

import (
	"fmt"
	"reflect"
	"runtime"
	"time"
	"unsafe"
)

type appConfig struct {
	Addr    string        `cfg:"ADDR,required"`
	Port    int           `cfg:"PORT,default=8080"`
	Debug   bool          `cfg:"DEBUG,default=false"`
	Timeout time.Duration `cfg:"TIMEOUT,default=2s"`
}

func main() {
	fmt.Println("══════ 1. 反射配置绑定 ══════")
	var config appConfig
	err := Bind(&config, map[string]string{"ADDR": "127.0.0.1", "DEBUG": "true"})
	fmt.Printf("config=%+v err=%v\n", config, err)

	fmt.Println("\n══════ 2. addressable 与 settable ══════")
	direct := reflect.ValueOf(config)
	throughPointer := reflect.ValueOf(&config).Elem()
	fmt.Printf("value: CanAddr=%v CanSet=%v\n", direct.CanAddr(), direct.CanSet())
	fmt.Printf("pointer.Elem: CanAddr=%v CanSet=%v\n", throughPointer.CanAddr(), throughPointer.CanSet())

	fmt.Println("\n══════ 3. 结构体布局 ══════")
	type wasteful struct {
		Enabled bool
		Count   int64
		Code    int16
	}
	type compact struct {
		Count   int64
		Code    int16
		Enabled bool
	}
	var bad wasteful
	var good compact
	fmt.Printf("wasteful=%+v offsets=[%d %d %d]\n", LayoutOf[wasteful](),
		unsafe.Offsetof(bad.Enabled), unsafe.Offsetof(bad.Count), unsafe.Offsetof(bad.Code))
	fmt.Printf("compact=%+v offsets=[%d %d %d]\n", LayoutOf[compact](),
		unsafe.Offsetof(good.Count), unsafe.Offsetof(good.Code), unsafe.Offsetof(good.Enabled))

	fmt.Println("\n══════ 4. 安全复制 vs unsafe 只读视图 ══════")
	source := []byte("immutable while viewed")
	safe := SafeBytesToString(source)
	view := UnsafeBytesToReadOnlyString(source)
	fmt.Printf("safe shares data=%v, unsafe shares data=%v\n",
		unsafe.StringData(safe) == unsafe.SliceData(source),
		unsafe.StringData(view) == unsafe.SliceData(source))
	runtime.KeepAlive(source)

	fmt.Println("\n══════ 5. 泛型保留命名类型 ══════")
	type Port int16
	port, err := ParseSigned[Port]("8080")
	fmt.Printf("port=%v type=%T err=%v\n", port, port, err)
	fmt.Println("原则：先写清楚的安全代码，再用 Benchmark 证明反射/复制确实是热点。")
}
