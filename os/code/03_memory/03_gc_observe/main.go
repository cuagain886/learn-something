// 03_gc_observe — 读懂 GC 的仪表盘：MemStats、GOGC、GOMEMLIMIT、归还 OS
//
// 学什么：
//  1. runtime.MemStats 核心字段：HeapAlloc(活着的)/HeapSys(向OS要的)/
//     HeapIdle-HeapReleased(攥着没还的)/NextGC(下次触发目标)/NumGC
//  2. GOGC 的倍率效应：SetGCPercent(50) vs (400) 下，同样的活跃堆，
//     GC 频率和峰值内存的此消彼长
//  3. GOMEMLIMIT(SetMemoryLimit) 逼近时 GC 提前发力——容器防 137 的官方旋钮
//  4. FreeOSMemory 强制归还：HeapReleased 上涨 = madvise 还给内核了(05章⑤)
//
// 运行：cd os/code && go run ./03_memory/03_gc_observe
// 进阶：GODEBUG=gctrace=1 go run ./03_memory/03_gc_observe  对照 06 章 §5 逐字段读
package main

import (
	"fmt"
	"runtime"
	"runtime/debug"
)

func mb(b uint64) float64 { return float64(b) / 1024 / 1024 }

func report(stage string) runtime.MemStats {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	fmt.Printf("%-30s HeapAlloc=%6.1fMB  HeapSys=%6.1fMB  未还OS=%6.1fMB  NextGC=%6.1fMB  NumGC=%d\n",
		stage, mb(m.HeapAlloc), mb(m.HeapSys),
		mb(m.HeapIdle-m.HeapReleased), mb(m.NextGC), m.NumGC)
	return m
}

// churn 制造分配压力：liveMB 常驻 + churnMB 短命垃圾
func churn(liveMB, churnMB int) [][]byte {
	live := make([][]byte, 0, liveMB)
	for i := 0; i < liveMB; i++ {
		b := make([]byte, 1<<20)
		b[0] = 1 // touch 一页, 确保真实占用
		live = append(live, b)
	}
	for i := 0; i < churnMB; i++ {
		g := make([]byte, 1<<20)
		g[0] = 1
		_ = g // 立刻变垃圾
	}
	return live
}

func main() {
	fmt.Println("== 阶段 1: 基线与 GOGC=100 的稳态 ==")
	report("启动基线")
	live := churn(100, 300) // 100MB 常驻 + 300MB 垃圾
	m := report("100MB常驻+300MB垃圾后")
	fmt.Printf("   注意 NextGC≈HeapAlloc×2 —— GOGC=100 的含义：堆翻倍才触发下一轮\n\n")

	fmt.Println("== 阶段 2: GOGC 的倍率效应 ==")
	debug.SetGCPercent(50) // 相当于 GOGC=50: 活×1.5 就触发 → 勤快省内存费CPU
	before := report("SetGCPercent(50) 后").NumGC
	_ = churn(0, 200)
	after := report("再产 200MB 垃圾").NumGC
	fmt.Printf("   GOGC=50 期间 GC 跑了 %d 轮\n", after-before)

	debug.SetGCPercent(400) // 活×5 才触发 → 懒省CPU费内存
	before = report("SetGCPercent(400) 后").NumGC
	_ = churn(0, 200)
	after = report("再产 200MB 垃圾").NumGC
	fmt.Printf("   GOGC=400 期间 GC 只跑了 %d 轮 —— 峰值内存换 CPU\n\n", after-before)

	fmt.Println("== 阶段 3: GOMEMLIMIT —— 容器防 OOM 的软上限 ==")
	debug.SetGCPercent(100)
	debug.SetMemoryLimit(180 << 20) // 180MB 软上限(常驻100MB, 余量不大)
	before = report("SetMemoryLimit(180MB) 后").NumGC
	_ = churn(0, 300)
	m = report("限额下再产 300MB 垃圾")
	fmt.Printf("   GC 增加到 %d 轮且 HeapSys 被按在限额附近 —— 逼近限额时 GC 主动提前,\n", m.NumGC-before)
	fmt.Printf("   这就是'多花 CPU 换不被 OOM Kill'的交易(容器里设 limit×0.9)\n\n")
	debug.SetMemoryLimit(-1) // 解除, -1 = 恢复无限

	fmt.Println("== 阶段 4: 归还 OS —— HeapReleased 的变化 ==")
	live = nil // 丢掉 100MB 常驻引用
	_ = live
	report("释放常驻引用后(GC未必立刻跑)")
	runtime.GC()
	report("手动 runtime.GC() 后")
	debug.FreeOSMemory() // 强制 GC + 立即 madvise 归还
	report("FreeOSMemory() 后")
	fmt.Println(`   对比最后两行的"未还OS": scavenger 平时慢慢还, FreeOSMemory 立刻还。
   ⚠️ 别把 FreeOSMemory 当保健品——只在"刚释放巨量内存且短期不用"时有意义。`)
}
