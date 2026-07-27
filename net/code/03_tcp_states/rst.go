// rst.go —— RST 的三种典型产生场景
//
// ================================ 本节概览 ================================
//
// 【这个程序演示什么】
//
//	RST（reset）是 TCP 的"强制拆线"报文：不走四次挥手，收到即刻销毁连接、
//	丢弃缓冲区、不进 TIME_WAIT。线上三条最常见的错误信息，背后都是它：
//
//	  场景一  connection refused        连一个没人 listen 的端口
//	  场景二  connection reset by peer  对端用 SO_LINGER=0 关闭（发 RST 而非 FIN）
//	  场景三  第一次 write 成功、第二次才报错   往一个已经被对端销毁的连接上写
//
//	三个场景都在进程内自带对端，单终端 `go run . -mode rst` 即可跑完，
//	每一步都会打印原始 error + errno 数字 + 中文含义。
//
// 【怎么运行】
//
//	go run . -mode rst
//
// 【预期观察到什么】
//
//	Linux/WSL2  ：errno 111(ECONNREFUSED) / 104(ECONNRESET) / 32(EPIPE)
//	Windows     ：errno 10061 / 10054 / 10054（Windows 没有独立的 EPIPE 语义）
//	字符串不一样，但报文层面完全是同一回事：都是收到了 RST。
//
// 【⚠️ 跨平台大坑】
//
//	errors.Is(err, syscall.ECONNREFUSED) 在 Windows 上恒为 false —— 因为
//	Windows 真实错误码是 WSAECONNREFUSED(10061)，而 syscall.ECONNREFUSED
//	在 Windows 上只是个占位值。判断逻辑见 observe.go 的 explainErr()。
//
// 【抓包验证（可选，强烈建议做一次）】
//
//	Linux/WSL2 : sudo tcpdump -i lo -nn 'tcp[tcpflags] & tcp-rst != 0'
//	Windows    : Wireshark 选 Npcap Loopback Adapter，过滤 tcp.flags.reset == 1
//	跑本程序时能直接看到三个场景各自打出的 RST 包。
//
// =========================================================================
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"time"
)

func runRST(ctx context.Context) error {
	obs{
		Title: "想看到 RST 报文本身，先开抓包再跑本程序",
		Linux: []string{
			"sudo tcpdump -i lo -nn 'tcp[tcpflags] & tcp-rst != 0'",
		},
		Win: []string{
			"Wireshark → Npcap Loopback Adapter → 过滤 tcp.flags.reset == 1",
		},
		Expect: []string{
			"三个场景各自打出至少一个 RST 包",
			"RST 之后连接直接消失，ss 里看不到任何残留状态（连 TIME_WAIT 都没有）",
		},
		Why: []string{
			"RST 不走四次挥手，也就不进 TIME_WAIT —— 这是有人拿 SO_LINGER=0 '优化' TIME_WAIT 的动机",
			"代价是发送缓冲区里没发完的数据直接丢，对端只会收到 RST，永远不知道少了什么",
		},
	}.print()

	if err := rstScenarioRefused(ctx); err != nil {
		return err
	}
	if err := rstScenarioLinger0(ctx); err != nil {
		return err
	}
	if err := rstScenarioWriteAfterClose(ctx); err != nil {
		return err
	}

	fmt.Println()
	fmt.Println(sep)
	fmt.Println("【三个场景的排障对照表】")
	fmt.Println("  connection refused        → 对端主机可达，但那个端口没人 listen。")
	fmt.Println("                              查：服务起没起、端口写没写错、容器端口映射对不对。")
	fmt.Println("                              ⚠️ 若对面防火墙是 DROP 而不是 REJECT，你看到的会是")
	fmt.Println("                                 i/o timeout 而不是 refused —— 这两个的区分是排障分水岭：")
	fmt.Println("                                 refused = 包到了、被明确拒绝；timeout = 包可能压根没到。")
	fmt.Println("  connection reset by peer  → 收到 RST，连接在对端已不存在。")
	fmt.Println("                              查：对端进程是否崩溃/重启、是否 SO_LINGER=0、")
	fmt.Println("                                 中间是否有 LB/NAT/防火墙把空闲连接回收了（Agent 长连接常见）。")
	fmt.Println("  写成功但对端没收到        → write 只保证'拷进了内核发送缓冲区'，不保证对端收到。")
	fmt.Println("                              要确认对端真的处理了，只能靠应用层 ACK（响应/回执）。")
	fmt.Println(sep)
	return nil
}

// ------------------------------------------------------------------
// 场景一：连一个没人监听的端口 → connection refused
// ------------------------------------------------------------------

func rstScenarioRefused(ctx context.Context) error {
	section("场景一", "连一个没人 listen 的端口 → 对端内核回 RST → connection refused")

	// 先 Listen 一个随机端口拿到端口号，再立刻关掉 —— 这样能拿到一个
	// "刚才确实空闲"的端口，比随手写死一个端口号可靠。
	// ⚠️ 理论上存在竞争：关掉之后到 Dial 之前，可能被别的进程抢去 listen。
	//    概率极低，真撞上了重跑一次即可。
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	dead := ln.Addr().String()
	if err := ln.Close(); err != nil { // Listener 的 Close：就在这里，故意关掉
		return err
	}
	log.Printf("目标 %s 现在没有任何进程在 listen", dead)

	d := net.Dialer{Timeout: 3 * time.Second}
	start := time.Now()
	conn, err := d.DialContext(ctx, "tcp", dead)
	cost := time.Since(start)
	if err == nil {
		conn.Close()
		log.Printf("意外：竟然连上了（端口在这一瞬间被别人占了），重跑一次即可")
		return nil
	}
	log.Printf("Dial 失败，耗时 %v", cost.Round(time.Microsecond))
	log.Printf("  原始 error : %v", err)
	log.Printf("  含义       : %s", explainErr(err))
	log.Printf("  报文层面   : 我方发 SYN → 对端内核发现该端口无监听 → 直接回 RST+ACK → 连接建立失败")
	log.Printf("  ⚠️ 关键特征 : 失败几乎是【瞬时】的（本机 %v），因为不需要等任何超时。", cost.Round(time.Microsecond))
	log.Printf("     对比 i/o timeout：那是 SYN 反复重传都没人应答，要等好几秒甚至几十秒。")
	log.Printf("     线上判断'服务挂了'还是'网络不通'，先看这个耗时。")

	// 顺带演示"没到达 refused，而是超时"的对照：连一个不可达的地址。
	// ⚠️ 192.0.2.0/24 是 RFC 5737 保留的文档用地址段，不会真的路由到任何地方。
	log.Printf("对照：连一个不可路由的地址 192.0.2.1:80（RFC 5737 文档保留段），设 1.5s 超时…")
	d2 := net.Dialer{Timeout: 1500 * time.Millisecond}
	start = time.Now()
	c2, err2 := d2.DialContext(ctx, "tcp", "192.0.2.1:80")
	cost2 := time.Since(start)
	if err2 == nil {
		c2.Close()
		log.Printf("  意外：连上了（你的网络里这个段被劫持了？），跳过本对照")
	} else {
		log.Printf("  耗时 %v，error: %s", cost2.Round(time.Millisecond), explainErr(err2))
		log.Printf("  → 没有 RST 可收，只能干等超时。这就是 DROP 型防火墙背后的现象。")
	}
	return nil
}

// ------------------------------------------------------------------
// 场景二：SO_LINGER=0 → close 发 RST → 对端读到 connection reset by peer
// ------------------------------------------------------------------

func rstScenarioLinger0(ctx context.Context) error {
	section("场景二", "SetLinger(0) 后 Close → 发 RST 而不是 FIN → 对端读到 connection reset by peer")

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer ln.Close() // Listener 的 Close：本场景结束时关闭

	done := make(chan struct{})
	go func() {
		defer close(done)
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close() // 被害者一侧的 Close：函数退出时释放 fd
		log.Printf("[对端] 接受连接，等 400ms 之后再读（让 RST 先到）")
		time.Sleep(400 * time.Millisecond)

		if err := c.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
			return
		}
		buf := make([]byte, 256)
		n, rerr := c.Read(buf)
		log.Printf("[对端] Read 返回 n=%d", n)
		log.Printf("[对端]   原始 error : %v", rerr)
		log.Printf("[对端]   含义       : %s", explainErr(rerr))
		if rerr != nil && !errors.Is(rerr, io.EOF) {
			log.Printf("[对端]   ⚠️ 注意：读到的不是 io.EOF！")
			log.Printf("[对端]      对端正常 Close() → 我们读到 io.EOF（收到 FIN，数据完整）")
			log.Printf("[对端]      对端 SO_LINGER=0 Close() → 我们读到 ECONNRESET（收到 RST，数据可能残缺）")
			log.Printf("[对端]      这两者在应用层必须区别对待：EOF 可以正常收尾，RST 必须当异常处理。")
		}
	}()

	conn, err := net.DialTimeout("tcp", ln.Addr().String(), 3*time.Second)
	if err != nil {
		return err
	}
	tcp, ok := conn.(*net.TCPConn)
	if !ok {
		conn.Close()
		return fmt.Errorf("拿到的不是 *net.TCPConn，无法 SetLinger")
	}

	// ⚠️ SetLinger(0) 的语义：close() 时【不等待】发送缓冲区排空，
	//    直接发 RST 拆连接。副作用有两个：
	//      1. 缓冲区里还没发出去的数据直接丢，对端永远收不到，也不知道丢了。
	//      2. 不进 TIME_WAIT（因为压根没走四次挥手）。
	//    有人拿第 2 条来"优化"TIME_WAIT —— 这是拿数据完整性换端口，
	//    只有在"连接内容已经无所谓"（比如已经决定丢弃这个请求）时才勉强可用。
	if err := tcp.SetLinger(0); err != nil {
		conn.Close()
		return err
	}
	log.Printf("[本端] SetLinger(0) 已生效")

	if err := conn.SetWriteDeadline(time.Now().Add(3 * time.Second)); err != nil {
		conn.Close()
		return err
	}
	if _, err := conn.Write([]byte("这条数据大概率会被 RST 一起丢掉")); err != nil {
		conn.Close()
		return err
	}
	log.Printf("[本端] 已 Write（只是拷进了内核发送缓冲区，还不代表对端收到）")
	time.Sleep(100 * time.Millisecond)

	// Close 的位置：就是这一行。因为 SetLinger(0)，它发出的是 RST 而不是 FIN。
	log.Printf("[本端] Close() —— 由于 linger=0，内核发出的是 RST")
	if err := conn.Close(); err != nil {
		log.Printf("[本端] Close 出错: %s", explainErr(err))
	}

	select {
	case <-done:
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(5 * time.Second):
		log.Printf("等待对端超时，跳过")
	}
	return nil
}

// ------------------------------------------------------------------
// 场景三：对端已完全关闭，我方继续写 → 第一次成功，第二次才报错
// ------------------------------------------------------------------

func rstScenarioWriteAfterClose(ctx context.Context) error {
	section("场景三", "对端已 Close()，我方继续 Write → 第 1 次'成功'，第 2 次才报错")

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer ln.Close()

	// peerClosed 只是为了让演示【确定性复现】：
	// 保证服务端第一次 Write 时，客户端确实已经 Close 完毕。
	// 真实线上没有这个信号——服务端根本不知道对端什么时候没的，
	// 这正是"write 返回 nil 却没送达"如此难查的原因。
	peerClosed := make(chan struct{})

	done := make(chan struct{})
	go func() {
		defer close(done)
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()

		if err := c.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
			return
		}
		buf := make([]byte, 256)
		n, rerr := c.Read(buf)
		log.Printf("[服务端] 收到请求 %d 字节: %q", n, trunc(buf[:n], 40))
		if rerr != nil {
			log.Printf("[服务端] 读结束: %s", explainErr(rerr))
		}

		select {
		case <-peerClosed:
		case <-time.After(3 * time.Second):
		}

		// 对端此时已经完全 Close（读写两个方向都关了）。
		// 我们连写 4 次，观察从第几次开始报错。
		for i := 1; i <= 4; i++ {
			if err := c.SetWriteDeadline(time.Now().Add(2 * time.Second)); err != nil {
				return
			}
			_, werr := c.Write([]byte(fmt.Sprintf("响应分片 #%d ——对端其实早就走了\n", i)))
			if werr == nil {
				log.Printf("[服务端] Write #%d 返回 nil ✅（注意：这【不代表】对端收到了！）", i)
			} else {
				log.Printf("[服务端] Write #%d 失败 ❌: %s", i, explainErr(werr))
			}
			time.Sleep(150 * time.Millisecond)
		}
		log.Printf("[服务端] ⚠️ 结论：write 返回 nil 只说明数据进了【本机内核发送缓冲区】。")
		log.Printf("[服务端]    对端收到数据后发现 socket 已销毁 → 回 RST；")
		log.Printf("[服务端]    这个 RST 要等【下一次】write/read 才会以错误的形式暴露给应用。")
		log.Printf("[服务端]    这就是'日志显示发送成功，对端却说没收到'的经典成因。")
		log.Printf("[服务端]    ⚠️ 具体错误码看平台和时序：")
		log.Printf("[服务端]       Linux  ：第 2 次通常是 EPIPE(32)，也可能先报 ECONNRESET(104)")
		log.Printf("[服务端]       Windows：10054(WSAECONNRESET) 或 10053(WSAECONNABORTED) 都可能，")
		log.Printf("[服务端]                取决于 RST 到达和这次 send 的先后。两者含义一样：连接已被 RST 掉。")
		log.Printf("[服务端]    → 所以业务代码别去 match 错误字符串，要按语义分类（见 observe.go 的 explainErr）。")
	}()

	conn, err := net.DialTimeout("tcp", ln.Addr().String(), 3*time.Second)
	if err != nil {
		return err
	}
	if err := conn.SetWriteDeadline(time.Now().Add(3 * time.Second)); err != nil {
		conn.Close()
		return err
	}
	if _, err := conn.Write([]byte("GET /something")); err != nil {
		conn.Close()
		return err
	}
	time.Sleep(150 * time.Millisecond)

	// 客户端完全 Close：读方向也一并关闭。
	// ⚠️ 和 halfclose.go 里的 CloseWrite() 对比 ——
	//    CloseWrite 只关写方向，还能继续读；Close 是两个方向都关，
	//    之后任何到达的数据都会触发本机内核回 RST。
	log.Printf("[客户端] Close()：读写两个方向全关，之后收到任何数据都会回 RST")
	if err := conn.Close(); err != nil {
		log.Printf("[客户端] Close 出错: %s", explainErr(err))
	}
	// 通知服务端"现在可以开始写了"，让下面的输出确定性复现。
	close(peerClosed)

	select {
	case <-done:
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(8 * time.Second):
		log.Printf("等待服务端超时，跳过")
	}
	return nil
}

func section(no, title string) {
	fmt.Println()
	fmt.Println(sep)
	fmt.Printf("【%s】%s\n", no, title)
	fmt.Println(sep)
}
