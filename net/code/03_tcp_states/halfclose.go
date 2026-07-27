// halfclose.go —— 半关闭（half-close）：CloseWrite() vs Close()
//
// ================================ 本节概览 ================================
//
// 【这个程序演示什么】
//
//	TCP 是全双工的：一条连接上有两个方向的字节流，可以分别关闭。
//
//	  CloseWrite()  ≈ shutdown(fd, SHUT_WR)
//	      只关【写方向】：发一个 FIN 告诉对端"我说完了"，
//	      但读方向还开着，对端后续发来的数据照收不误。
//	      本端状态：ESTABLISHED → FIN_WAIT_1 → FIN_WAIT_2（在这里等对端的响应和 FIN）
//	      对端状态：ESTABLISHED → CLOSE_WAIT（合法且短暂：它正在生成响应）
//
//	  Close()       ≈ close(fd)
//	      两个方向一起关，并且【释放 fd】。之后对端再发来的任何数据，
//	      本机内核都会回 RST —— 因为已经没有 socket 能收了。
//
//	经典应用：`nc host port < file`、HTTP/1.0 的 "发完请求就 shutdown 写方向"、
//	以及所有"请求发完了，但响应还没来"的单次请求-响应协议。
//
// 【怎么运行】
//
//	go run . -mode halfclose        # 单终端，进程内自带服务端
//
// 【预期观察到什么】
//
//	演示 A（CloseWrite，正确）：客户端能完整读到服务端在 FIN 之后才写出的响应。
//	演示 B（Close，错误）    ：客户端什么都读不到，服务端的 write 从第 2 次开始报错。
//
// 【为什么演示 A 是正确的】
//
//	CloseWrite 传达的语义是"请求到此结束（EOF），但我还在听"。
//	服务端因此能用 io.ReadAll 干净地读到请求边界，再从容地写响应。
//	对照 02_sticky_packets：如果不用半关闭，就得靠长度前缀或分隔符自己划边界。
//
// 【为什么演示 B 是错误的】
//
//	Close() 把读方向也关了，等于告诉对端"我不听了"，但对端并不知道 ——
//	它还在老老实实生成响应。响应发过来，撞上一个已经不存在的 socket，
//	换回一个 RST。服务端的第一次 write 甚至还会返回 nil（数据只是进了发送缓冲区），
//	第二次才暴露错误。日志里看起来"发送成功"，实际上一个字节都没送达。
//
// 【⚠️ 三个坑】
//
//  1. CloseWrite/CloseRead 只有 *net.TCPConn / *net.UnixConn 有，
//     net.Conn 接口上没有 —— 必须类型断言，断言失败要有兜底。
//  2. CloseWrite 之后【仍然要 Close()】，否则 fd 泄漏。
//     半关闭只关了协议上的一个方向，没有释放文件描述符。
//  3. 别在 net/http 里手动 CloseWrite：HTTP/1.1 的连接由 Transport 管理和复用，
//     手动半关闭会让连接池拿到一条残废连接。
//
// 【延伸：不是所有 CLOSE_WAIT 都是 bug】
//
//	演示 A 里服务端也会短暂处于 CLOSE_WAIT（它收到了 FIN，正在算响应）。
//	这是协议设计的一部分。判断标准不是"有没有 CLOSE_WAIT"，
//	而是"CLOSE_WAIT 会不会散、数量会不会只涨不跌"。
//
// =========================================================================
package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"time"
)

// respChunks 是服务端分几次写出的响应。分多次写才能看出
// 演示 B 里"第一次 write 成功、第二次才失败"的现象。
var respChunks = []string{
	"HTTP-ish/1.0 200 OK\n",
	"X-Note: 这一段是在收到你的 FIN 之后才写出来的\n",
	"\n",
	"如果你看得到这段正文，说明半关闭确实只关了一个方向。\n",
}

func runHalfClose(ctx context.Context) error {
	obs{
		Title: "想看状态迁移，另开一个终端盯着（本程序两个演示各留了 1.2 秒观察窗口）",
		Linux: []string{
			"watch -n0.2 \"ss -tan '( src 127.0.0.1 or dst 127.0.0.1 )' | grep -E 'FIN-WAIT|CLOSE-WAIT|LAST-ACK'\"",
		},
		Win: []string{
			"while($true){ Get-NetTCPConnection -LocalAddress 127.0.0.1 -ErrorAction SilentlyContinue | " +
				"Where-Object State -in 'FinWait1','FinWait2','CloseWait','LastAck' | Format-Table -Auto; sleep 0.3 }",
		},
		Expect: []string{
			"演示 A 期间：客户端侧 FIN_WAIT_2 + 服务端侧 CLOSE_WAIT 成对出现约 1 秒，然后一起消失",
			"演示 B 期间：几乎抓不到中间状态，连接直接被 RST 掉",
		},
		Why: []string{
			"演示 A 的 CLOSE_WAIT 是【合法的】：服务端正在生成响应，算完就 Close",
			"判断 CLOSE_WAIT 是不是 bug，看的是它散不散、数量涨不涨，而不是有没有出现过",
		},
	}.print()

	if err := halfCloseGood(ctx); err != nil {
		return err
	}
	if err := halfCloseBad(ctx); err != nil {
		return err
	}

	fmt.Println()
	fmt.Println(sep)
	fmt.Println("【对照总结】")
	fmt.Println("                       客户端能收到响应吗   服务端 write 结果      本端状态轨迹")
	fmt.Println("  CloseWrite()（正确）  ✅ 完整收到          全部成功                FIN_WAIT_1 → FIN_WAIT_2 → TIME_WAIT")
	fmt.Println("  Close()（错误）       ❌ 一个字节都收不到  第 1 次 nil，之后 RST   直接消失（对端收到 RST）")
	fmt.Println()
	fmt.Println("  记忆锚点：")
	fmt.Println("    · FIN 是【单向】的：它只说明'我不再发了'，不代表'我不再收了'。")
	fmt.Println("    · 四次挥手之所以是四次，正是因为两个方向要各关一次（对比三次握手只建一条连接）。")
	fmt.Println("    · CloseWrite() 之后仍需 Close()，否则 fd 泄漏。")
	fmt.Println(sep)
	return nil
}

// ------------------------------------------------------------------
// 演示 A：CloseWrite —— 正确
// ------------------------------------------------------------------

func halfCloseGood(ctx context.Context) error {
	section("演示 A（正确）", "客户端 CloseWrite() 只关写方向 → 仍能读到服务端的完整响应")

	ln, srvDone, err := startEchoResponder()
	if err != nil {
		return err
	}
	defer ln.Close() // Listener 的 Close：本演示结束时关

	conn, err := net.DialTimeout("tcp", ln.Addr().String(), 3*time.Second)
	if err != nil {
		return err
	}
	// ⚠️ 即使做了半关闭，Close 依然必须调 —— 它负责把 fd 还给内核。
	defer conn.Close()

	tcp, ok := conn.(*net.TCPConn)
	if !ok {
		return fmt.Errorf("需要 *net.TCPConn 才能 CloseWrite")
	}

	if err := conn.SetWriteDeadline(time.Now().Add(3 * time.Second)); err != nil {
		return err
	}
	if _, err := conn.Write([]byte("GET /half-close\n请求正文到此为止\n")); err != nil {
		return err
	}
	log.Printf("[客户端] 请求已发送")

	// ★ 关键一行：只关写方向。
	//   内核发出 FIN → 本端 FIN_WAIT_1；对端读到 io.EOF，知道请求结束了。
	//   读方向完全不受影响。
	if err := tcp.CloseWrite(); err != nil {
		return err
	}
	log.Printf("[客户端] CloseWrite()：发出 FIN，本端 → FIN_WAIT_1/FIN_WAIT_2；读方向仍然开着")

	// 读到 EOF 为止，把服务端的响应全部收下。
	if err := conn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return err
	}
	body, err := io.ReadAll(conn)
	if err != nil {
		log.Printf("[客户端] 读响应出错: %s", explainErr(err))
	}
	log.Printf("[客户端] CloseWrite 之后仍读到 %d 字节 ✅：", len(body))
	for _, line := range splitLines(string(body)) {
		log.Printf("[客户端]   | %s", line)
	}
	if len(body) > 0 {
		log.Printf("[客户端] → 证明 FIN 只关了一个方向，TCP 确实是全双工的")
	}

	waitDone(ctx, srvDone, 5*time.Second)
	time.Sleep(200 * time.Millisecond)
	return nil
}

// ------------------------------------------------------------------
// 演示 B：Close —— 错误
// ------------------------------------------------------------------

func halfCloseBad(ctx context.Context) error {
	section("演示 B（错误）", "客户端直接 Close() 全关 → 服务端的响应撞上 RST，客户端什么都收不到")

	ln, srvDone, err := startEchoResponder()
	if err != nil {
		return err
	}
	defer ln.Close()

	conn, err := net.DialTimeout("tcp", ln.Addr().String(), 3*time.Second)
	if err != nil {
		return err
	}
	if err := conn.SetWriteDeadline(time.Now().Add(3 * time.Second)); err != nil {
		conn.Close()
		return err
	}
	if _, err := conn.Write([]byte("GET /full-close\n请求正文到此为止\n")); err != nil {
		conn.Close()
		return err
	}
	log.Printf("[客户端] 请求已发送")

	// ❌ 问题在这里：Close() 把读方向也关了。
	//    服务端接下来写的响应无处可去，本机内核只能回 RST。
	//    应用层的表现：客户端"没收到响应"，服务端"以为发出去了"——
	//    双方日志各说各话，排查时极易互相甩锅。
	log.Printf("[客户端] Close()：读写两个方向一起关，fd 也释放了")
	if err := conn.Close(); err != nil {
		log.Printf("[客户端] Close 出错: %s", explainErr(err))
	}
	log.Printf("[客户端] 已经没有 Conn 可读了 ❌ —— 服务端的响应对我们来说不存在")

	waitDone(ctx, srvDone, 6*time.Second)
	time.Sleep(200 * time.Millisecond)
	return nil
}

// ------------------------------------------------------------------
// 两个演示共用的服务端
// ------------------------------------------------------------------

// startEchoResponder 起一个只服务一条连接的服务端：
// 读到 EOF（对端的 FIN）→ 假装处理 1 秒 → 分片写响应 → Close。
// 返回 Listener 和一个"服务端处理完成"的 channel。
func startEchoResponder() (net.Listener, <-chan struct{}, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, nil, err
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		c, err := ln.Accept()
		if err != nil {
			return
		}
		// 服务端侧 Close 的位置：处理完这一条连接就释放。
		defer c.Close()

		if err := c.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
			return
		}
		// io.ReadAll 读到 io.EOF 才返回 —— 也就是"等对端说完"。
		// 这一刻服务端进入 CLOSE_WAIT，这是合法的、短暂的。
		req, rerr := io.ReadAll(c)
		if rerr != nil {
			log.Printf("[服务端] 读请求出错: %s", explainErr(rerr))
			return
		}
		log.Printf("[服务端] 读到 io.EOF：请求结束，共 %d 字节 %q", len(req), trunc(req, 30))
		log.Printf("[服务端] 此刻本端处于 CLOSE_WAIT（合法：正在生成响应）")

		// 假装处理 1.2 秒，给读者留出敲 ss 的时间窗口。
		time.Sleep(1200 * time.Millisecond)

		for i, chunk := range respChunks {
			if err := c.SetWriteDeadline(time.Now().Add(3 * time.Second)); err != nil {
				return
			}
			_, werr := c.Write([]byte(chunk))
			if werr == nil {
				log.Printf("[服务端] Write 分片 %d/%d 成功", i+1, len(respChunks))
			} else {
				log.Printf("[服务端] Write 分片 %d/%d 失败 ❌: %s", i+1, len(respChunks), explainErr(werr))
			}
			time.Sleep(120 * time.Millisecond)
		}
		log.Printf("[服务端] 响应写完，Close()")
	}()
	return ln, done, nil
}

func waitDone(ctx context.Context, done <-chan struct{}, d time.Duration) {
	select {
	case <-done:
	case <-ctx.Done():
	case <-time.After(d):
		log.Printf("等待服务端超时（%v），继续", d)
	}
}

// splitLines 把响应按行拆开，日志里逐行打印更易读。
func splitLines(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			if line := s[start:i]; line != "" {
				out = append(out, line)
			}
			start = i + 1
		}
	}
	if start < len(s) {
		out = append(out, s[start:])
	}
	return out
}
