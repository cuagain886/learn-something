// 05_slow_client — 慢客户端的内存堆积：复现与四层防御
//
// 学什么：
//  1. 复现完整因果链：客户端读得慢 → 内核发送缓冲满 → Write 阻塞
//     → goroutine 挂起 → ⚠️【它持有的响应数据无法释放】→ 累积 OOM
//  2. 关键认知：问题不是 goroutine 多（goroutine 很便宜），
//     而是每个挂起的 goroutine 都抓着一份大数据不放
//  3. 四层防御对比：全量缓冲 vs 流式生成 vs 写超时 vs 单连接上限
//
// 运行：cd os/code && go run ./04_io/05_slow_client
package main

import (
	"fmt"
	"net"
	"runtime"
	"sync"
	"time"
)

const (
	respSize    = 8 << 20 // 每个响应 8MB
	numClients  = 20      // 20 个慢客户端
	chunkSize   = 32 << 10
	clientSpeed = 16 << 10 // 客户端每 10ms 只读 16KB —— 很慢
)

func heapMB() float64 {
	runtime.GC()
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return float64(m.HeapAlloc) / 1024 / 1024
}

// ---- 服务端两种写法 ------------------------------------------------------

// ⚠️ 错误版：先在内存里生成完整响应，再一次性 Write。
// 客户端慢 → Write 阻塞 → 这 8MB 全程被 goroutine 持有。
func handleBuffered(conn net.Conn) {
	defer conn.Close()
	resp := make([]byte, respSize) // ← 8MB 一次性分配，直到写完才能回收
	for i := range resp {
		resp[i] = byte(i)
	}
	conn.Write(resp) // 客户端读得多慢，这里就阻塞多久，8MB 就占多久
}

// ✅ 正确版：流式生成 + 写超时 + 单连接上限。
// 任何时刻只持有一个 chunk（32KB）；背压天然传导：写阻塞 → 生成也停下。
func handleStreaming(conn net.Conn, writeTimeout time.Duration) {
	defer conn.Close()
	chunk := make([]byte, chunkSize) // ← 唯一的缓冲，复用到底
	sent := 0
	for sent < respSize {
		// 防御①: 写超时 —— 最基本的止损，绝不能省
		conn.SetWriteDeadline(time.Now().Add(writeTimeout))

		n := min(chunkSize, respSize-sent)
		for i := 0; i < n; i++ {
			chunk[i] = byte(sent + i) // 防御②: 用到才生成，不预先攒全量
		}
		if _, err := conn.Write(chunk[:n]); err != nil {
			// 防御③: 超时/出错就断开 —— 保护整体优于伺候个体
			return
		}
		sent += n
	}
}

// ---- 慢客户端模拟 --------------------------------------------------------

func slowClient(addr string, wg *sync.WaitGroup, stop <-chan struct{}) {
	defer wg.Done()
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		return
	}
	defer conn.Close()
	buf := make([]byte, clientSpeed)
	for {
		select {
		case <-stop:
			return
		default:
		}
		conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		if _, err := conn.Read(buf); err != nil {
			return
		}
		time.Sleep(10 * time.Millisecond) // 慢：每 10ms 才读 16KB
	}
}

func runScenario(name string, handler func(net.Conn)) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}
	defer ln.Close()

	stop := make(chan struct{})
	var serverWg sync.WaitGroup
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			serverWg.Add(1)
			go func() { defer serverWg.Done(); handler(conn) }()
		}
	}()

	base := heapMB()
	baseG := runtime.NumGoroutine()

	var clientWg sync.WaitGroup
	for i := 0; i < numClients; i++ {
		clientWg.Add(1)
		go slowClient(ln.Addr().String(), &clientWg, stop)
	}

	// 等连接建立并卡住，测峰值
	time.Sleep(1200 * time.Millisecond)
	peakHeap := heapMB() - base
	peakG := runtime.NumGoroutine() - baseG

	close(stop)
	clientWg.Wait()
	ln.Close()
	serverWg.Wait()

	fmt.Printf("  %-32s 堆峰值 +%6.1f MB   goroutine +%d\n", name, peakHeap, peakG)
}

func main() {
	fmt.Printf("场景: %d 个慢客户端(每 10ms 读 %dKB), 每个请求 %dMB 响应\n\n",
		numClients, clientSpeed>>10, respSize>>20)

	fmt.Println("== 服务端两种写法对比 ==")
	runScenario("⚠️ 全量缓冲(无超时)", handleBuffered)
	runScenario("✅ 流式+写超时(500ms)", func(c net.Conn) {
		handleStreaming(c, 500*time.Millisecond)
	})

	fmt.Printf(`
读数说明:
  全量缓冲: 每连接持有 %dMB × %d 个 ≈ %dMB —— goroutine 数量正常，内存却爆了
            ⚠️ 这就是"heap profile 里全是 []byte 但 goroutine 数不多"的经典画像
  流式版:   每连接只持有 %dKB chunk，写超时后主动断开，内存与连接数几乎无关

四层防御(生产必备):
  ① 写超时         conn.SetWriteDeadline / http.Server{WriteTimeout}
                   ⚠️ Go 的 http.Server 零值【所有超时都是 0】= 无超时, Slowloris 敞开
  ② 流式生成       别 renderAll() 再 Write；边生成边发，背压自然传导到生成侧
  ③ 单连接缓冲上限  在途字节超限直接 Close —— 保护整体优于伺候个体
  ④ 全局在途上限    所有连接的缓冲之和也要有天花板(信号量/令牌桶, 第 04 章)

排查现场:
  ss -ntp | awk '$3 > 100000'     # Send-Q 大 = 数据堆在内核发不出去
  curl -s localhost:6060/debug/pprof/goroutine?debug=2 | grep -c 'poll.*Write'
`, respSize>>20, numClients, (respSize>>20)*numClients, chunkSize>>10)
}
