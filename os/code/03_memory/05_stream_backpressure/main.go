// 05_stream_backpressure — 防 OOM 五板斧实战：流式、限额、背压
//
// 学什么：
//  1. 板斧①② 流式+分块：处理"1GB 数据流"，ReadAll 版 vs 流式版的堆占用天壤之别
//  2. 板斧⑤ 输出限制：CappedBuffer——工具狂写 1GB，我们只留 1MB + truncated 标记
//     （对外永远"写成功"：限的是我们的存储，不是子进程的命）
//  3. 板斧③ 背压：有界队列满时生产者被顶住——内存曲线封顶，代价是生产变慢
//     ⚠️ 无界队列的本质：把"今天的拒绝"攒成"明天的 OOM"
//
// 运行：cd os/code && go run ./03_memory/05_stream_backpressure
package main

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"io"
	"runtime"
	"sync"
	"time"
)

func heapMB() float64 {
	runtime.GC()
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return float64(m.HeapAlloc) / 1024 / 1024
}

// bigStream 模拟一个 1GB 的数据源（工具 stdout / 上传文件 / 下载体）
// 用 LimitReader 包住一个无限零流，不占任何真实内存
func bigStream() io.Reader {
	return io.LimitReader(zeroReader{}, 1<<30)
}

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) { return len(p), nil }

// ---- 板斧①②: 流式 + 分块 ------------------------------------------------

func demoStreaming() {
	fmt.Println("== 任务: 计算 1GB 数据流的 SHA-256 ==")

	// ⚠️ 错误版：io.ReadAll —— 1GB 全进内存。真实世界这里就是容器 137 的案发点。
	// (demo 只读 256MB 意思一下, 免得小内存机器真炸)
	base := heapMB()
	data, _ := io.ReadAll(io.LimitReader(zeroReader{}, 256<<20))
	sum := sha256.Sum256(data)
	fmt.Printf("  ReadAll 版(只敢读256MB): 堆峰值 +%.0f MB, hash=%x...\n", heapMB()-base, sum[:4])
	data = nil
	_ = data

	// ✅ 流式版：64KB 缓冲循环喂给哈希器——处理 1GB，堆占用可忽略
	base = heapMB()
	h := sha256.New()
	buf := make([]byte, 64<<10) // 唯一的缓冲, 复用到底(板斧②分块)
	n, err := io.CopyBuffer(h, bigStream(), buf)
	if err != nil {
		panic(err)
	}
	fmt.Printf("  流式版(完整 1GB):        堆增量 +%.2f MB, 处理=%dMB, hash=%x... ✅\n\n",
		heapMB()-base, n>>20, h.Sum(nil)[:4])
}

// ---- 板斧⑤: 输出限额 -----------------------------------------------------

// CappedBuffer: Runner 每个任务配一个——超上限丢弃并打标, 对写入方永远报成功
type CappedBuffer struct {
	mu        sync.Mutex
	buf       bytes.Buffer
	limit     int
	total     int64 // 写入方实际产生的总量(含被丢弃的), 留给审计
	Truncated bool
}

func (c *CappedBuffer) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.total += int64(len(p))
	if room := c.limit - c.buf.Len(); room > 0 {
		if len(p) > room {
			p = p[:room]
			c.Truncated = true
		}
		c.buf.Write(p)
	} else {
		c.Truncated = true
	}
	return len(p), nil // ⚠️ 永远全额"成功"：子进程不该因我们的限额而写失败
}

func demoCapped() {
	fmt.Println("== 板斧⑤: 工具狂写 1GB, 我们只存 1MB ==")
	base := heapMB()
	cb := &CappedBuffer{limit: 1 << 20}
	written, _ := io.Copy(cb, bigStream()) // 模拟子进程 stdout 全量涌入
	fmt.Printf("  工具产出=%dMB, 实际留存=%.1fMB, truncated=%v, 堆增量=+%.1fMB ✅\n",
		written>>20, float64(cb.buf.Len())/1024/1024, cb.Truncated, heapMB()-base)
	fmt.Printf("  任务结果里记录: total=%dMB(审计), 输出已截断——用户知情, 内存无恙\n\n", cb.total>>20)
}

// ---- 板斧③: 有界队列的背压 ------------------------------------------------

func demoBackpressure() {
	fmt.Println("== 板斧③: 快生产者 vs 慢消费者 ==")
	const items = 200
	produce := func(queue chan []byte) (peakHeap float64) {
		var wg sync.WaitGroup
		wg.Add(1)
		go func() { // 慢消费者: 每件 1ms
			defer wg.Done()
			for range queue {
				time.Sleep(time.Millisecond)
			}
		}()
		base := heapMB()
		for i := 0; i < items; i++ {
			b := make([]byte, 1<<20) // 每件 1MB
			b[0] = 1
			queue <- b // 有界: 满了就在这里被顶住(背压); 无界: 永不阻塞, 内存起飞
			if i%50 == 0 {
				if h := heapMB() - base; h > peakHeap {
					peakHeap = h
				}
			}
		}
		close(queue)
		wg.Wait()
		return peakHeap
	}

	peakUnbounded := produce(make(chan []byte, items)) // 容量=全量 ≈ 无界
	peakBounded := produce(make(chan []byte, 8))       // 容量 8 → 在途最多 ~9MB

	fmt.Printf("  '无界'(容量%d): 堆峰值 ≈ %.0f MB —— 生产多快, 内存就多高\n", items, peakUnbounded)
	fmt.Printf("  有界(容量8):    堆峰值 ≈ %.0f MB ✅ —— 内存封顶, 生产者被迫等消费者\n", peakBounded)
	fmt.Println(`
要点回顾:
  1. 大小不可信的数据一律流式+分块, ReadAll 只配已知小的东西
  2. 输出限额限的是"我方存储", 写入方永远成功——审计记 total, 用户看 truncated
  3. 队列容量 = 内存预算 ÷ 单件大小; 顶住生产者不是故障, 是系统在自保
  4. 第四板斧(超阈值落盘 spooling)见 07 章临时文件; 五斧齐出才敢说"不会 OOM"`)
}

func main() {
	demoStreaming()
	demoCapped()
	demoBackpressure()
}
