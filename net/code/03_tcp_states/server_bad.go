// server_bad.go —— 【错误示例】复现 CLOSE_WAIT 堆积
//
// ================================ 本节概览 ================================
//
// 【这个程序演示什么】
//
//	线上最经典的连接泄漏：对端已经关了，我这边没关。
//	handler 读完一次请求，就卡在"下游调用"上（下游 HTTP 没设超时、数据库连接池
//	耗尽、拿不到锁……），既不再读这条连接，也永远不 Close()。
//
//	对端 close 之后发来 FIN，内核收下、回 ACK、把连接置为 CLOSE_WAIT，
//	然后就只能干等——因为发出本端的 FIN 必须由应用调 Close() 触发。
//	于是这条连接永久卡在 CLOSE_WAIT：占着一个 fd、一份内核收发缓冲区、
//	一个 goroutine。并发一上来，"too many open files"就来了。
//
//	  ESTABLISHED --收到FIN--> CLOSE_WAIT --(应用永不 Close)--> 卡死
//
// 【问题在哪】（三处，代码里用 ❌ 标出）
//
//	❌ 问题 1：handler 入口没有 defer c.Close()
//	❌ 问题 2：读了一次就不再读，感知不到对端已经走了
//	❌ 问题 3：卡在一个没有超时的"下游调用"上，goroutine 也一起泄漏
//
//	真实世界里这三个问题常常合体：
//	  · handler 里 recover 住了 panic，但 Close 写在了 panic 之后的正常路径上
//	  · 提前 return 的分支（参数校验失败、鉴权失败）漏了 Close
//	  · 把 conn 塞进一个 map/队列"等会儿再处理"，然后再也没人处理
//
// 【怎么运行】
//
//	终端A: go run . -mode server-bad
//	终端B: go run . -mode client-close -n 20      # 20 条连接，发完就关
//	终端C: 敲观察命令（见程序启动时打印的观察点）
//
// 【预期观察到什么】
//
//	服务端侧 CLOSE_WAIT 数量 = 客户端已关闭的连接数，且【只增不减】。
//	把客户端进程杀掉、等几分钟，数字纹丝不动 —— 这就是"泄漏"和"慢"的区别。
//
// 【怎么在自己项目里定位到具体代码】
//
//  1. ss 确认 CLOSE_WAIT 堆在哪个端口 → 定位到是哪个服务、哪个 Listener。
//  2. Go 服务打 goroutine 全栈：kill -QUIT <pid>（需 GOTRACEBACK=all），
//     或访问 /debug/pprof/goroutine?debug=2。
//  3. 栈里会有一大坨 goroutine 卡在同一行代码上 —— 那一行就是漏 Close 的现场。
//     本示例里，它会是下面 blockOnDownstream() 里的那次等待。
//
// =========================================================================
package main

import (
	"context"
	"errors"
	"log"
	"net"
	"sync"
	"time"
)

// leaked 故意持有所有泄漏的连接。
//
// ⚠️ 这不是为了"更像 bug"，而是为了让 bug 稳定复现：
//
//	Go 的 net.netFD 上挂了 finalizer（runtime.SetFinalizer(fd, (*netFD).Close)），
//	一个连接如果彻底不可达了，GC 可能会替你把 fd 关掉，CLOSE_WAIT 就自己消失了，
//	实验现象变得时有时无。
//	而真实线上的泄漏之所以永久存在，恰恰是因为 conn 还被某个 goroutine 栈、
//	某个 map 或某个队列持有着 —— 我们要精确模拟的正是这一点。
//
// ⚠️ 反过来说：不要指望 GC 帮你收连接。finalizer 何时跑没有任何保证，
//
//	等 GC 兜底的代码在高并发下必然先撞上 fd 上限。
var leaked struct {
	sync.Mutex
	conns []net.Conn
}

func runServerBad(ctx context.Context) error {
	ln, err := net.Listen("tcp", cfg.addr)
	if err != nil {
		return err
	}
	defer ln.Close()

	port := portOf(ln.Addr().String())
	log.Printf("监听 %s（每条连接会在'下游调用'里卡 %v，且永不 Close）", ln.Addr(), cfg.hold)

	obs{
		Title: "CLOSE_WAIT 堆积：数量只增不减",
		Linux: []string{
			ssAll(port),
			ssCountState("close-wait", "sport = :"+port),
			"watch -n1 \"" + ssCountState("close-wait", "sport = :"+port) + "\"   # 盯着看它只涨不跌",
		},
		Win: []string{
			psGroup(port),
			"(Get-NetTCPConnection -LocalPort " + port + " -State CloseWait -ErrorAction SilentlyContinue).Count",
		},
		Expect: []string{
			"服务端侧（sport = :" + port + "）出现一堆 CLOSE_WAIT，数量 = 客户端已关闭的连接数",
			"客户端进程退出后，这些 CLOSE_WAIT 依然在；等几分钟也不会自己消失",
			"对端（客户端）那一侧对应的是 FIN_WAIT_2，同样赖着不走",
		},
		Why: []string{
			"CLOSE_WAIT 停在谁那边，谁就是【收到了 FIN 却迟迟不 Close() 的那一方】",
			"内核能自动完成 FIN 的 ACK，但发出本端的 FIN 只能由应用调 Close() 触发",
			"所以 CLOSE_WAIT 堆积 100% 是应用层 bug，调内核参数没有任何用",
			"对端的 FIN_WAIT_2 也会被拖着 —— 你的 bug 会连累上游一起漏 fd",
		},
	}.print()

	go func() {
		<-ctx.Done()
		log.Println("收到 Ctrl+C：关闭 Listener")
		ln.Close()
	}()

	// 每 5 秒播报一次泄漏计数，让"只增不减"直接写在日志里。
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				leaked.Lock()
				n := len(leaked.conns)
				leaked.Unlock()
				if n > 0 {
					log.Printf("累计泄漏连接 %d 条（它们此刻大概率全在 CLOSE_WAIT）—— 注意这个数字永远不会下降", n)
				}
			}
		}
	}()

	for {
		conn, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				break
			}
			return err
		}
		// ⚠️ 这里连 wg.Add 都没有：进程退出时这些 goroutine 是被强杀的，
		//    正因如此，泄漏在进程活着的时候永远不会被"清理"。
		go handleLeak(ctx, conn)
	}

	leaked.Lock()
	n := len(leaked.conns)
	leaked.Unlock()
	log.Printf("退出：本次共泄漏 %d 条连接（进程一退出，内核才替你把它们全关掉）", n)

	obs{
		Title: "进程退出后再看一眼",
		Linux: []string{ssAll(port)},
		Win:   []string{psGroup(port)},
		Expect: []string{
			"刚才那批 CLOSE_WAIT 瞬间消失（可能短暂变成 TIME_WAIT/LAST_ACK 再消失）",
		},
		Why: []string{
			"进程退出时内核回收全部 fd，等价于替你补上了那些 Close()",
			"这解释了线上那句'重启一下就好了' —— 重启只是把泄漏清零，bug 还在代码里",
		},
	}.print()
	return nil
}

func handleLeak(ctx context.Context, c net.Conn) {
	remote := c.RemoteAddr().String()

	// ❌ 问题 1：这里【没有】defer c.Close()。
	//    对照 server_good.go 的 handleEchoGood —— 差别就这一行。
	//
	// 显式持有引用，确保泄漏稳定复现（原因见上面 leaked 变量的注释）。
	leaked.Lock()
	leaked.conns = append(leaked.conns, c)
	n := len(leaked.conns)
	leaked.Unlock()

	// 只读这一次。读到的既可能是数据，也可能直接是 EOF。
	// 注意：不管应用读不读，只要对端的 FIN 到了，内核就会把连接置为 CLOSE_WAIT。
	if err := c.SetReadDeadline(time.Now().Add(30 * time.Second)); err != nil {
		return
	}
	buf := make([]byte, 4096)
	nr, err := c.Read(buf)
	switch {
	case err == nil:
		log.Printf("[%s] 收到 %d 字节: %q（这是第 %d 条泄漏连接）", remote, nr, trunc(buf[:nr], 40), n)
	default:
		log.Printf("[%s] 读结束: %s", remote, explainErr(err))
	}

	// ❌ 问题 2：读完这一次就不再读了。
	//    对端随后发来的 FIN 永远不会被这个 handler 感知到 ——
	//    对应用来说"什么都没发生"，对内核来说连接已经半死。
	//
	// ❌ 问题 3：卡在一个没有超时的下游调用上。
	//    真实对应物：http.Client 没设 Timeout、SQL 没设 context deadline、
	//    等一把永远拿不到的锁、往一个没人消费的 channel 里写……
	blockOnDownstream(ctx, remote, cfg.hold)

	// ❌ 就算下游终于返回了，这里 return 之前依然没有 Close()。
	//    conn 还躺在 leaked.conns 里，fd 一直被占着。
	log.Printf("[%s] '下游调用'返回了，handler 退出 —— 但连接从头到尾没被 Close()", remote)
}

// blockOnDownstream 模拟一次永远（或很久）不返回的下游调用。
//
// 排查技巧：在真实服务里打 goroutine 全栈时，会看到成百上千个 goroutine
// 停在这个函数对应的那一行。栈里数量最多的那一行，就是泄漏的源头。
func blockOnDownstream(ctx context.Context, remote string, d time.Duration) {
	log.Printf("[%s] 开始'调用下游'，预计阻塞 %v（期间这条连接会一直是 CLOSE_WAIT）", remote, d)
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
	case <-ctx.Done():
	}
}

// trunc 把字节切片截断成便于打印的字符串。
// ⚠️ 按 rune 截而不是按 byte 截：中文一个字 3 字节，
// 按字节切会把 UTF-8 序列拦腰砍断，日志里出现 \xe5\x88 这种乱码。
func trunc(b []byte, max int) string {
	r := []rune(string(b))
	if len(r) > max {
		return string(r[:max]) + "…"
	}
	return string(r)
}
