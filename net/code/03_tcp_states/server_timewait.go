// server_timewait.go —— 【对照实验】服务端主动关闭，TIME_WAIT 堆在服务端
//
// ================================ 本节概览 ================================
//
// 【这个程序演示什么】
//
//	上一个实验（client-timewait + server-good）里 TIME_WAIT 堆在客户端；
//	这里把"谁先发 FIN"反过来：服务端回完一条响应就立刻 Close()。
//	结果是 TIME_WAIT 全部堆在服务端侧。
//
//	一句话结论（本示例最想让你记住的一句）：
//	    TIME_WAIT 出现在哪一侧，哪一侧就是【主动关闭方】（先发 FIN 的那一方）。
//
//	所以线上看到"服务端一堆 TIME_WAIT"，第一反应不该是"调内核参数"，
//	而是先回答：我的服务端为什么在主动关连接？常见答案：
//	  · 响应带了 Connection: close（HTTP/1.0 客户端、或服务端主动禁用 keepalive）
//	  · 服务端设了很短的 idle timeout，抢在客户端前面踢连接
//	  · Nginx/网关的 keepalive_timeout 比上游短，网关成了主动关闭方
//
//	本端主动关闭时的状态轨迹：
//	  ESTABLISHED --我方Close()发FIN--> FIN_WAIT_1 --收到ACK--> FIN_WAIT_2
//	              --收到对端FIN--> TIME_WAIT --等 2MSL--> CLOSED
//
// 【TIME_WAIT 为什么必须存在】（两个理由，缺一不可）
//
//  1. 保证最后那个 ACK 能重发：如果对端没收到我们的 ACK 会重传 FIN，
//     我们必须还"活着"才能再 ACK 一次；否则对端收到的是 RST。
//  2. 让旧连接的迷途报文（lost duplicate）在网络里彻底消散，
//     避免它们被同一四元组的新连接误收。2MSL 就是为这个留的安全期。
//
// 【怎么运行】
//
//	终端A: go run . -mode server-timewait
//	终端B: go run . -mode client-timewait -passive -n 300
//	       （-passive 让客户端等服务端先发 FIN，客户端做被动关闭方）
//
// 【预期观察到什么】
//
//	服务端侧（sport = :9000）大量 TIME_WAIT，60~120 秒后自行消失；
//	客户端侧（dport = :9000）几乎没有 TIME_WAIT。
//
// 【⚠️ 一个常见误解】
//
//	"服务端 TIME_WAIT 多会耗尽端口" —— 通常不会。
//	TIME_WAIT 占用的是【四元组】(本地IP,本地端口,对端IP,对端端口)，
//	服务端的本地端口是固定的监听端口，变化的是对端端口，所以端口不会被耗尽。
//	服务端 TIME_WAIT 真正的代价是内存 / conntrack 表项，以及重启时
//	若没开 SO_REUSEADDR 会 bind 失败（Go 的 net.Listen 默认已经开了）。
//	端口耗尽是【客户端侧】的问题 —— 见 client.go 里的推算。
//
// =========================================================================
package main

import (
	"context"
	"errors"
	"log"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

func runServerTimeWait(ctx context.Context) error {
	ln, err := net.Listen("tcp", cfg.addr)
	if err != nil {
		return err
	}
	defer ln.Close()

	port := portOf(ln.Addr().String())
	log.Printf("监听 %s（回一条响应就主动 Close，等价于 HTTP 的 Connection: close）", ln.Addr())

	obs{
		Title: "服务端主动关闭 → TIME_WAIT 堆在服务端侧",
		Linux: []string{
			ssCountState("time-wait", "sport = :"+port) + "   # 服务端侧",
			ssCountState("time-wait", "dport = :"+port) + "   # 客户端侧（应该接近 0）",
			"ss -tan state time-wait '( sport = :" + port + " )' | head",
		},
		Win: []string{
			psGroup(port) + "        # 本地端口是 " + port + " → 服务端侧",
			psGroupRemote(port) + "  # 远端端口是 " + port + " → 客户端侧",
		},
		Expect: []string{
			"服务端侧 TIME_WAIT 数量 ≈ 客户端发起的连接数",
			"客户端侧（-passive 模式）TIME_WAIT 接近 0",
			"停止客户端后，服务端的 TIME_WAIT 会在 60s（Linux）/ 120s（Windows 默认）后自行清零",
		},
		Why: []string{
			"TIME_WAIT 在哪一侧，哪一侧就是主动关闭方 —— 这是判断'谁先挂电话'的唯一可靠依据",
			"服务端出现大量 TIME_WAIT，要查的是'我为什么在主动关连接'，不是内核参数",
			"它会自己消失（2MSL 到期），这是它和 CLOSE_WAIT 的本质区别：一个是等待，一个是泄漏",
		},
	}.print()

	go func() {
		<-ctx.Done()
		log.Println("收到 Ctrl+C：关闭 Listener")
		ln.Close()
	}()

	var wg sync.WaitGroup
	var served int64
	for {
		conn, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				break
			}
			return err
		}
		wg.Add(1)
		go func(c net.Conn) {
			defer wg.Done()
			serveOnceThenClose(c, atomic.AddInt64(&served, 1))
		}(conn)
	}
	wg.Wait()

	n := atomic.LoadInt64(&served)
	log.Printf("退出：共处理 %d 条连接，其中每一条都由服务端主动关闭", n)

	obs{
		Title: "退出后：TIME_WAIT 还在，但会自己消失",
		Linux: []string{ssCountState("time-wait", "sport = :"+port)},
		Win:   []string{psGroup(port)},
		Expect: []string{
			"进程都退出了，服务端侧仍有一批 TIME_WAIT —— 它属于内核，不属于进程",
			"再等 60s（Linux）/ 120s（Windows）左右复查，会归零",
		},
		Why: []string{
			"TIME_WAIT 由内核维护，杀进程杀不掉它；这也是为什么服务重启后有时会 bind 失败",
			"Linux 的 2MSL 写死在内核里（TCP_TIMEWAIT_LEN=60s）不可调；Windows 可改注册表 TcpTimedWaitDelay",
			"⚠️ 想'消灭 TIME_WAIT'的正确方向是改成长连接（复用），而不是 tw_reuse/tw_recycle 这类邪招",
			"   （net.ipv4.tcp_tw_recycle 因为在 NAT 后会误丢包，Linux 4.12 起已被彻底移除）",
		},
	}.print()
	return nil
}

// serveOnceThenClose：读一条请求，回一条响应，然后【服务端主动 Close】。
func serveOnceThenClose(c net.Conn, seq int64) {
	remote := c.RemoteAddr().String()
	// Close 的位置：defer 钉在入口。注意这里的 Close 同时也是"主动发 FIN"的动作，
	// 它让本端进入 FIN_WAIT_1 → … → TIME_WAIT。
	defer func() {
		_ = c.Close()
		if seq%50 == 0 {
			log.Printf("[%s] 第 %d 条：服务端主动 Close() → 本端 FIN_WAIT_1 → … → TIME_WAIT", remote, seq)
		}
	}()

	if err := c.SetReadDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return
	}
	buf := make([]byte, 4096)
	n, err := c.Read(buf)
	if err != nil && n == 0 {
		log.Printf("[%s] 读失败: %s", remote, explainErr(err))
		return
	}
	if err := c.SetWriteDeadline(time.Now().Add(writeTimeout)); err != nil {
		return
	}
	if _, err := c.Write(buf[:n]); err != nil {
		log.Printf("[%s] 写失败: %s", remote, explainErr(err))
	}
	// return → defer Close() → 服务端成为主动关闭方
}
