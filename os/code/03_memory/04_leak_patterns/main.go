// 04_leak_patterns — 逻辑内存泄漏：GC 说没泄，业务说泄了
//
// 学什么：
//  1. 泄漏模式 A：子切片钉住大底层数组——留 8 字节, 押着 100MB
//  2. 泄漏模式 B：只增不删的 map 缓存——每个请求都留下一点"纪念品"
//  3. 测量手法：先 GC 再 ReadMemStats 的前后对比（排除垃圾干扰）
//     ⚠️ 这类泄漏 heap profile 里全是"可达对象"，-race/-vet 都不报——
//     只有【业务语义】知道它们不该活着，所以叫逻辑泄漏
//
// 运行：cd os/code && go run ./03_memory/04_leak_patterns
package main

import (
	"fmt"
	"runtime"
	"slices"
)

func heapMB() float64 {
	runtime.GC() // 先清垃圾, 量出来的才是"真活着的"
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return float64(m.HeapAlloc) / 1024 / 1024
}

// ---- 模式 A: 子切片钉住大数组 -------------------------------------------

// ⚠️ 错误版：从 100MB 报文里取 8 字节的头——切片不拷贝，只是"窗口"，
// 底层 100MB 数组因为这 8 字节的引用而整体不可回收
func headerBuggy(packet []byte) []byte {
	return packet[:8]
}

// ✅ 修复版：真的只要 8 字节，就把它拷出来，放走大数组
func headerFixed(packet []byte) []byte {
	return slices.Clone(packet[:8]) // 或 append([]byte(nil), packet[:8]...)
}

func demoSubslice() {
	fmt.Println("== 模式 A: 子切片钉住大底层数组 ==")
	base := heapMB()

	var headers [][]byte
	for i := 0; i < 5; i++ {
		packet := make([]byte, 100<<20) // 模拟收到 100MB 大报文
		packet[0] = byte(i)
		headers = append(headers, headerBuggy(packet))
	} // packet 们"看似"没人要了
	fmt.Printf("  错误版: 留了 5 个 8字节头, 堆却涨了 %.0f MB —— 5 个 100MB 数组全被钉住\n",
		heapMB()-base)
	runtime.KeepAlive(headers)

	headers = nil
	base = heapMB()
	for i := 0; i < 5; i++ {
		packet := make([]byte, 100<<20)
		packet[0] = byte(i)
		headers = append(headers, headerFixed(packet))
	}
	fmt.Printf("  修复版: 同样留 5 个头, 堆只涨 %.2f MB ✅ (Clone 断开与大数组的关系)\n\n",
		heapMB()-base)
	runtime.KeepAlive(headers)
}

// ---- 模式 B: 只增不删的缓存 ---------------------------------------------

type session struct{ data [64 << 10]byte } // 每会话 64KB

func demoGrowOnlyMap() {
	fmt.Println("== 模式 B: 只增不删的 map 缓存 ==")
	base := heapMB()

	// ⚠️ 错误版：以 sessionID 为 key 一路存, 没有过期、没有上限——
	// 模拟 2000 个"已结束但没清理"的会话
	cache := map[int]*session{}
	for id := 0; id < 2000; id++ {
		cache[id] = &session{}
	}
	fmt.Printf("  错误版: 2000 个已结束会话滞留, 堆涨 %.0f MB, 且随流量单调上涨\n",
		heapMB()-base)

	// ✅ 修复方向(生产用 LRU+TTL, 这里演示最小闭环): 会话结束就 delete
	for id := 0; id < 2000; id++ {
		delete(cache, id)
	}
	fmt.Printf("  修复版: 及时 delete 后, 堆回落到 +%.1f MB ✅\n", heapMB()-base)
	runtime.KeepAlive(cache)

	fmt.Println(`
生产级修复清单:
  1. 一切缓存必须三有: 有容量上限(LRU) / 有过期(TTL) / 有监控(len 曝光成指标)
  2. 定位手法: heap profile 用 -base 做小时级 diff, 增长栈落在 map 赋值行即实锤
  3. ⚠️ map 删空后 bucket 内存不还(桶只增不缩) —— 千万级后回落需求要定期重建 map
     (版本背景: Go 1.24 起 swiss table 实现改善但"删不缩"仍是默认心智)`)
}

func main() {
	demoSubslice()
	demoGrowOnlyMap()
}
