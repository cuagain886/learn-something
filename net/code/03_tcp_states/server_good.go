// server_good.go —— 【正确示例】echo 服务端：读到 io.EOF 立刻 Close()
//
// ================================ 本节概览 ================================
//
// 【这个程序演示什么】
//
//	一个"健康"的 TCP 服务端长什么样，作为 server_bad.go 的对照组。
//	核心只有一句话：Read 返回 io.EOF 的那一刻，对端已经发来 FIN，
//	本端进入 CLOSE_WAIT；此时唯一正确的动作是立刻 Close()。
//
//	四次挥手在本端这一侧的完整轨迹：
//	  ESTABLISHED --收到FIN--> CLOSE_WAIT --我方Close()--> LAST_ACK --收到ACK--> CLOSED
//	                            ↑                ↑
//	                     内核自动完成       只有应用层能触发
//
//	CLOSE_WAIT 这一站，内核帮不了你——它必须等应用调 close(fd)。
//	这就是"CLOSE_WAIT 堆积一定是应用层 bug"的根本原因。
//
// 【怎么运行】
//
//	终端A: go run . -mode server-good
//	终端B: go run . -mode client-timewait -n 500     # 打短连接
//	   或: go run . -mode client-close -n 20         # 发完就关
//	   或: telnet 127.0.0.1 9000                     # 手工敲字，看 echo
//
// 【预期观察到什么】
//
//	服务端侧几乎抓不到 CLOSE_WAIT（存活时间是微秒级）。
//	能抓到的只有 ESTABLISHED，以及客户端侧的一堆 TIME_WAIT。
//
// 【为什么这么写是正确的】
//
//  1. handler 入口第一行就 defer Close()——无论 return / panic / 提前 break，
//     fd 一定还给内核。这是 Go 里防连接泄漏的唯一可靠姿势。
//  2. 每次 Read/Write 前都设 Deadline——没有 Deadline 的网络调用，
//     等于给自己埋一颗"goroutine 永久阻塞 + fd 永久泄漏"的雷。
//  3. Ctrl+C 先关 Listener（停止收新连接），再等存量连接跑完——优雅关闭。
//
// =========================================================================
package main

import (
	"context"
	"errors"
	"io"
	"log"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// 单次 Write 的超时。写一般很快（只是拷进内核发送缓冲区），
// 但对端不读、窗口为 0 时 Write 会阻塞——所以照样必须有 Deadline。
const writeTimeout = 10 * time.Second

func runServerGood(ctx context.Context) error {
	ln, err := net.Listen("tcp", cfg.addr)
	if err != nil {
		return err
	}
	// Listener 的 Close 位置：函数返回时兜底关一次。
	// 下面的 goroutine 在 Ctrl+C 时也会关，重复 Close 只会返回 ErrClosed，无害。
	defer ln.Close()

	port := portOf(ln.Addr().String())
	log.Printf("监听 %s（读空闲超时 %v）", ln.Addr(), cfg.idle)

	obs{
		Title: "健康服务端：CLOSE_WAIT 应该几乎抓不到",
		Linux: []string{
			ssAll(port),
			ssCountState("close-wait", "sport = :"+port),
		},
		Win: []string{
			psGroup(port),
		},
		Expect: []string{
			"客户端跑起来时：服务端侧一堆 ESTABLISHED，随客户端结束而消失",
			"close-wait 计数始终是 1（wc -l 把表头也算进去了，即实际 0 条）",
			"客户端侧（dport = :" + port + "）会堆一批 TIME_WAIT —— 那是客户端主动关闭的代价",
		},
		Why: []string{
			"CLOSE_WAIT 抓不到 ≠ 没经过这个状态，而是它只存在了几微秒",
			"决定 CLOSE_WAIT 停留多久的，永远是应用层从 EOF 到 Close() 的那段代码",
		},
	}.print()

	// Ctrl+C：先关 Listener，Accept 立刻返回 net.ErrClosed，跳出循环。
	go func() {
		<-ctx.Done()
		log.Println("收到 Ctrl+C：关闭 Listener，停止接受新连接（存量连接继续跑完）")
		ln.Close()
	}()

	var wg sync.WaitGroup
	var total, live int64

	for {
		conn, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				break // 正常退出路径：Listener 被 Ctrl+C 关了
			}
			// ⚠️ 临时性错误（比如 fd 用尽）不该直接退出整个服务端，
			//    生产代码通常会 sleep 一小会儿再 continue。这里教学起见直接返回。
			return err
		}
		atomic.AddInt64(&total, 1)
		wg.Add(1)
		go func(c net.Conn) {
			defer wg.Done()
			n := atomic.AddInt64(&live, 1)
			defer atomic.AddInt64(&live, -1)
			handleEchoGood(c, n)
		}(conn)
	}

	log.Printf("等待 %d 条存量连接结束…", atomic.LoadInt64(&live))
	wg.Wait()
	log.Printf("全部结束：累计处理 %d 条连接，当前存活 %d 条", atomic.LoadInt64(&total), atomic.LoadInt64(&live))

	obs{
		Title: "退出后再看一眼",
		Linux: []string{ssAll(port)},
		Win:   []string{psGroup(port)},
		Expect: []string{
			"和端口 " + port + " 相关的连接全部消失（服务端侧没有任何残留）",
			"如果还看到 TIME_WAIT，检查它的 sport：是本机某个临时端口，说明那是客户端侧的残留",
		},
		Why: []string{
			"服务端正确 Close() 后不会留下 TIME_WAIT —— 因为它是被动关闭方",
			"TIME_WAIT 永远只出现在【先发 FIN 的那一侧】",
		},
	}.print()
	return nil
}

// handleEchoGood 处理一条连接：收什么回什么，读到 EOF 立刻收工。
func handleEchoGood(c net.Conn, live int64) {
	remote := c.RemoteAddr().String()

	// ✅ 正确点 1：Close 注册在函数入口，defer 是 LIFO，所以它最后执行 ——
	//    哪怕下面 panic 了、被 recover 了，Close 照样跑得到。
	defer func() {
		if err := c.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			log.Printf("[%s] Close 出错: %s", remote, shortErr(err))
		}
	}()
	// ✅ 正确点 2：recover 注册在 Close 之后 → 先于 Close 执行。
	//    对照 server_bad.go：那边的 bug 正是"recover 住了，但漏了 defer Close"。
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[%s] handler panic 了: %v（但 defer Close 仍会执行，连接不会泄漏）", remote, r)
		}
	}()

	log.Printf("[%s] 连接建立（当前存活 %d 条）", remote, live)

	buf := make([]byte, 4096)
	for {
		// ✅ 正确点 3：每次 Read 前刷新 Deadline。
		//    没有它，一个连上来不说话的客户端能占住一个 goroutine + 一个 fd 到天荒地老。
		if err := c.SetReadDeadline(time.Now().Add(cfg.idle)); err != nil {
			log.Printf("[%s] SetReadDeadline 失败: %s", remote, shortErr(err))
			return
		}
		n, err := c.Read(buf)
		if n > 0 {
			if err := c.SetWriteDeadline(time.Now().Add(writeTimeout)); err != nil {
				return
			}
			if _, werr := c.Write(buf[:n]); werr != nil {
				log.Printf("[%s] 回写失败: %s", remote, explainErr(werr))
				return
			}
		}
		if err != nil {
			switch {
			case errors.Is(err, io.EOF):
				// ★ 这是本文件的主角。
				// 收到 FIN 的瞬间，内核已经把这条连接置为 CLOSE_WAIT（这一步不需要应用参与），
				// 并且已经替我们 ACK 了对方的 FIN。接下来内核就干等着——
				// 等我们调 Close() 发出自己的 FIN，连接才能往 LAST_ACK 走。
				log.Printf("[%s] Read=io.EOF：对端发来 FIN，本端进入 CLOSE_WAIT → 立刻 Close() 转 LAST_ACK", remote)
			case isTimeout(err):
				// ⚠️ 这里本端是【主动关闭方】：是我们先发 FIN 的。
				//    所以本端会进 TIME_WAIT —— 服务端主动踢空闲连接就是这个代价。
				log.Printf("[%s] 空闲超过 %v，本端主动 Close()（本端将进入 TIME_WAIT）", remote, cfg.idle)
			default:
				log.Printf("[%s] 读失败: %s", remote, explainErr(err))
			}
			return // → 触发 defer Close()
		}
	}
}
