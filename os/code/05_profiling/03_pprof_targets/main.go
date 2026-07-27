// 03_pprof_targets — 五个故障靶场：按需触发，用 pprof 亲手定位
//
// 学什么：
//  1. 每个 HTTP 端点制造一种典型故障，对应第 12 章的五个剧本
//  2. 练习完整的定位链路：现象 → 选对 profile → top/list → 找到具体那一行
//  3. ⚠️ 每个靶场都【故意】写成生产里真实会犯的样子，不是玩具代码
//
// 运行：
//   cd os/code && go run ./05_profiling/03_pprof_targets
//   然后按提示触发故障并用 pprof 定位（每个端点的排查命令都打印出来了）
//
// pprof 端点在 :6060，靶场控制在 :8099
package main

import (
	"fmt"
	"log"
	"net"
	"net/http"
	_ "net/http/pprof" // 注册 /debug/pprof/* 到 DefaultServeMux
	"os"
	"regexp"
	"runtime"
	"sync"
	"time"
)

// ============================================================================
// 靶场 A：CPU 打满 —— 热路径里重复编译正则（生产事故 Top 3）
// ============================================================================

// ⚠️ 错误：每次调用都重新编译正则。regexp.MustCompile 是【昂贵】操作，
// 但它藏在函数内部时非常隐蔽——代码看起来很正常。
func validateEmailBad(s string) bool {
	re := regexp.MustCompile(`^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$`)
	return re.MatchString(s)
}

// ✅ 正确：编译一次，全局复用（regexp.Regexp 是并发安全的）
var emailRe = regexp.MustCompile(`^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$`)

func validateEmailGood(s string) bool { return emailRe.MatchString(s) }

func targetCPU(w http.ResponseWriter, r *http.Request) {
	mode := r.URL.Query().Get("mode")
	stop := time.Now().Add(30 * time.Second)
	n := 0
	for time.Now().Before(stop) {
		for i := 0; i < 1000; i++ {
			if mode == "fixed" {
				validateEmailGood("user@example.com")
			} else {
				validateEmailBad("user@example.com") // 热点在这一行
			}
			n++
		}
	}
	fmt.Fprintf(w, "跑了 30 秒，%d 次校验 (mode=%s)\n", n, mode)
}

// ============================================================================
// 靶场 B：goroutine 泄漏 —— 每个请求泄漏一个（第 03 章三种模式之一）
// ============================================================================

func targetGoroutineLeak(w http.ResponseWriter, r *http.Request) {
	for i := 0; i < 500; i++ {
		go func() {
			ch := make(chan int) // 无缓冲，且没有任何人会发送
			<-ch                 // ⚠️ 永久阻塞：这个 goroutine 再也不会退出
		}()
	}
	fmt.Fprintf(w, "泄漏了 500 个 goroutine，当前总数: %d\n", runtime.NumGoroutine())
}

// ============================================================================
// 靶场 C：内存泄漏 —— 只增不删的缓存（第 06 章 §2.6）
// ============================================================================

var (
	cacheMu sync.Mutex
	// ⚠️ 没有容量上限、没有 TTL、没有淘汰——教科书级的逻辑泄漏
	sessionCache = map[string][]byte{}
)

func targetMemLeak(w http.ResponseWriter, r *http.Request) {
	cacheMu.Lock()
	defer cacheMu.Unlock()
	for i := 0; i < 200; i++ {
		key := fmt.Sprintf("session-%d-%d", len(sessionCache), i)
		sessionCache[key] = make([]byte, 64*1024) // 每个 64KB
	}
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	fmt.Fprintf(w, "缓存条目: %d, HeapAlloc: %.1f MB\n",
		len(sessionCache), float64(m.HeapAlloc)/1024/1024)
}

// ============================================================================
// 靶场 D：fd 泄漏 —— 错误路径漏了 Close（第 07 章 §4.1）
// ============================================================================

var leakedConns []net.Conn // 故意持有，模拟真实泄漏中"引用还在但没人 Close"

func targetFdLeak(w http.ResponseWriter, r *http.Request) {
	// 用监听自己的方式制造 socket fd，跨平台且不依赖外部服务
	for i := 0; i < 50; i++ {
		c, err := net.Dial("tcp", leakTargetAddr)
		if err != nil {
			break
		}
		leakedConns = append(leakedConns, c) // ⚠️ 只存不关
	}
	fmt.Fprintf(w, "已泄漏 %d 个连接。排查: ls /proc/%d/fd | wc -l\n",
		len(leakedConns), os.Getpid())
}

var leakTargetAddr string

// ============================================================================
// 靶场 E：锁竞争 —— 临界区里做慢操作（第 04 章 §7 错误 3）
// ============================================================================

var (
	globalMu sync.Mutex
	counter  int
)

func targetLockContention(w http.ResponseWriter, r *http.Request) {
	mode := r.URL.Query().Get("mode")
	const workers = 50
	var wg sync.WaitGroup
	start := time.Now()

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 200; j++ {
				if mode == "fixed" {
					// ✅ 正确：慢操作放锁外，锁内只做共享状态读写
					data := slowCompute()
					globalMu.Lock()
					counter += data
					globalMu.Unlock()
				} else {
					// ⚠️ 错误：把耗时操作放在临界区里 —— 全体排队陪跑
					globalMu.Lock()
					counter += slowCompute()
					globalMu.Unlock()
				}
			}
		}()
	}
	wg.Wait()
	fmt.Fprintf(w, "mode=%s, %d workers × 200 次, 耗时 %v\n",
		mode, workers, time.Since(start).Round(time.Millisecond))
}

func slowCompute() int { // 模拟 50μs 的计算
	sum := 0
	for i := 0; i < 5000; i++ {
		sum += i % 7
	}
	return sum % 3
}

// ============================================================================

const banner = `
╔══════════════════════════════════════════════════════════════════════════╗
║  五个故障靶场 —— 对应第 12 章的五个剧本                                   ║
╚══════════════════════════════════════════════════════════════════════════╝

【靶场 A】CPU 打满
  触发:  curl 'localhost:8099/cpu'              (跑 30 秒)
  定位:  go tool pprof -top http://localhost:6060/debug/pprof/profile?seconds=20
         # 看 flat 最高的函数，然后:
         go tool pprof http://localhost:6060/debug/pprof/profile?seconds=20
         (pprof) list targetCPU      ← 定位到具体哪一行
  对照:  curl 'localhost:8099/cpu?mode=fixed'   (正则提到包级变量后)

【靶场 B】goroutine 泄漏
  触发:  curl localhost:8099/goroutine-leak     (每次泄漏 500 个, 多点几次)
  定位:  curl -s 'localhost:6060/debug/pprof/goroutine?debug=1' | head -20
         # 第一行就是最大嫌疑: 数量 + 创建栈
         # 隔 10 分钟采两次做 diff, 【净增长】才是泄漏

【靶场 C】内存泄漏
  触发:  for i in $(seq 20); do curl -s localhost:8099/mem-leak; done
  定位:  curl -s localhost:6060/debug/pprof/heap > /tmp/h1
         for i in $(seq 20); do curl -s localhost:8099/mem-leak >/dev/null; done
         curl -s localhost:6060/debug/pprof/heap > /tmp/h2
         go tool pprof -base /tmp/h1 -top /tmp/h2    ← 只看净增长
         # ⚠️ 用 inuse_space(默认) 找泄漏, 不是 alloc_space

【靶场 D】fd 泄漏
  触发:  for i in $(seq 10); do curl -s localhost:8099/fd-leak; done
  定位:  ls /proc/%d/fd | wc -l
         lsof -p %d | awk '{print $5}' | sort | uniq -c | sort -rn

【靶场 E】锁竞争
  触发:  time curl 'localhost:8099/lock'              (慢操作在锁内)
  对照:  time curl 'localhost:8099/lock?mode=fixed'   (慢操作在锁外)
  定位:  curl -s localhost:6060/debug/pprof/mutex > /tmp/m.out
         go tool pprof -top /tmp/m.out       ← 看等锁总时长排名
         # 也可以: strace -c -f -p %d  看 futex 占比

其他观测:
  go tool trace:  curl -o /tmp/t.out 'localhost:6060/debug/pprof/trace?seconds=5'
                  go tool trace /tmp/t.out
  GODEBUG:        GODEBUG=gctrace=1 go run ./05_profiling/03_pprof_targets
`

func main() {
	// 开启默认关闭的两种 profile —— 不开的话 mutex/block profile 是空的
	runtime.SetMutexProfileFraction(5) // 每 5 次锁竞争采样 1 次
	runtime.SetBlockProfileRate(10000) // 每阻塞 10μs 采样 1 次

	// 给靶场 D 准备一个连接目标（监听自己，避免依赖外部服务）
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	leakTargetAddr = ln.Addr().String()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			_ = c // 接受后不关，配合客户端一起制造 fd 占用
		}
	}()

	// pprof 端点 —— ⚠️ 只监听 localhost，绝不暴露公网
	go func() { log.Println(http.ListenAndServe("localhost:6060", nil)) }()

	mux := http.NewServeMux()
	mux.HandleFunc("/cpu", targetCPU)
	mux.HandleFunc("/goroutine-leak", targetGoroutineLeak)
	mux.HandleFunc("/mem-leak", targetMemLeak)
	mux.HandleFunc("/fd-leak", targetFdLeak)
	mux.HandleFunc("/lock", targetLockContention)
	mux.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		var m runtime.MemStats
		runtime.ReadMemStats(&m)
		fmt.Fprintf(w, "goroutine=%d  heap=%.1fMB  threads(M)≈见 schedtrace  GC=%d\n",
			runtime.NumGoroutine(), float64(m.HeapAlloc)/1024/1024, m.NumGC)
	})

	pid := os.Getpid()
	fmt.Printf(banner, pid, pid, pid)
	fmt.Printf("\n靶场控制: http://localhost:8099   pprof: http://localhost:6060/debug/pprof/\n")
	fmt.Printf("当前 pid=%d  基线 goroutine=%d\n\n", pid, runtime.NumGoroutine())

	// ⚠️ 生产环境必设三个超时（第 08 章 §4.3）——这里演示正确姿势
	srv := &http.Server{
		Addr:              ":8099",
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		WriteTimeout:      60 * time.Second, // 靶场 A 要跑 30 秒，留足余量
		IdleTimeout:       120 * time.Second,
	}
	log.Fatal(srv.ListenAndServe())
}
