// client.go —— 客户端两个子命令：复现 TIME_WAIT / 制造 CLOSE_WAIT
//
// ================================ 本节概览 ================================
//
// 【这个程序演示什么】
//
//	client-timewait：短时间打 N 条短连接，每条都由客户端主动 Close()。
//	                 主动关闭方进 TIME_WAIT → TIME_WAIT 全部堆在客户端侧。
//	                 跑完按实测速率推算"这个速率会不会把临时端口耗光"。
//	client-close   ：连一次、发一句话、立刻 Close()，不等回包。
//	                 配合 server-bad，用来在服务端留下永久的 CLOSE_WAIT。
//
// 【为什么客户端的 TIME_WAIT 才是真问题】
//
//	TIME_WAIT 占的是一个四元组：(本地IP, 本地端口, 对端IP, 对端端口)。
//	  · 服务端侧：本地端口 = 固定监听端口，变化的是对端端口 → 端口不会耗尽。
//	  · 客户端侧：对端 IP:端口固定（同一个下游服务），变化的是自己的临时端口
//	    （ephemeral port）→ 临时端口范围就是硬上限，用完就 "cannot assign
//	    requested address" / "address already in use"。
//
//	临时端口范围（默认值，可查/可调）：
//	  Linux  : cat /proc/sys/net/ipv4/ip_local_port_range → 32768 60999，共 28232 个
//	  Windows: netsh int ipv4 show dynamicport tcp        → 49152 起 16384 个
//
//	TIME_WAIT 持续时长（2MSL）：
//	  Linux  : 固定 60s（内核常量 TCP_TIMEWAIT_LEN，编译期写死，不可调）
//	  Windows: 注册表 TcpTimedWaitDelay，较新版本默认 120s（老版本 240s）
//
//	稳态下 TIME_WAIT 数量 ≈ 建连速率 × 2MSL 时长。所以对同一个下游服务，
//	短连接速率的天花板 ≈ 临时端口数 / 2MSL：
//	  Linux  ≈ 28232 / 60  ≈ 470 conn/s
//	  Windows≈ 16384 / 120 ≈ 136 conn/s
//	Agent 场景里"高频调 LLM API 一段时间后突然连不上"，十有八九就是撞了这条线。
//
// 【正确解法（按优先级）】
//
//  1. 改长连接 / 连接池复用（Go 里：共用一个 http.Client，别每次 new，
//     并且务必把 resp.Body 读完再 Close，否则连接回不了池，等于没复用）。
//  2. 让服务端做主动关闭方（把 TIME_WAIT 转移到不会耗尽端口的一侧）。
//  3. 扩临时端口范围（治标，能多撑一倍）。
//  4. Linux 开 net.ipv4.tcp_tw_reuse=1（只对【发起方】有效，且需要 timestamps）。
//     ⚠️ tcp_tw_recycle 不要碰：它在 NAT 环境下会丢包，Linux 4.12 起已被移除。
//  5. ⚠️ 用 SO_LINGER=0 让 close 发 RST 来"绕过 TIME_WAIT"是邪招：
//     会丢掉发送缓冲区里没发完的数据，见 rst.go 场景二。
//
// 【怎么运行】
//
//	终端A: go run . -mode server-good
//	终端B: go run . -mode client-timewait -n 500
//
//	终端A: go run . -mode server-timewait
//	终端B: go run . -mode client-timewait -passive -n 300   # 客户端做被动关闭方
//
//	终端A: go run . -mode server-bad
//	终端B: go run . -mode client-close -n 20
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

const (
	dialTimeout = 3 * time.Second
	rwTimeout   = 3 * time.Second

	// 临时端口范围与 2MSL 的默认值，用于跑完后的推算。
	linuxEphemeralPorts = 60999 - 32768 + 1 // 28232
	winEphemeralPorts   = 16384             // 49152..65535
	linuxTimeWaitSec    = 60.0              // TCP_TIMEWAIT_LEN，内核写死
	winTimeWaitSec      = 120.0             // TcpTimedWaitDelay 默认值
)

// ------------------------------------------------------------------
// client-timewait
// ------------------------------------------------------------------

func runClientTimeWait(ctx context.Context) error {
	n := nOr(500)
	port := portOf(cfg.addr)

	role := "主动关闭方（发完收完立刻 Close）→ 本端进 TIME_WAIT"
	if cfg.passive {
		role = "被动关闭方（一直读到 io.EOF，等对端先发 FIN）→ 本端不进 TIME_WAIT"
	}
	log.Printf("目标 %s，计划建立 %d 条短连接；本端角色：%s", cfg.addr, n, role)
	if cfg.passive {
		log.Printf("⚠️ -passive 需要服务端主动关闭，请确保对面跑的是 -mode server-timewait")
	}

	obs{
		Title: "跑的过程中就去看（跑完 TIME_WAIT 还会留 1~2 分钟，不用抢）",
		Linux: []string{
			ssCountState("time-wait", "dport = :"+port) + "   # 客户端侧",
			ssCountState("time-wait", "sport = :"+port) + "   # 服务端侧",
			"ss -s                                            # 总览：TCP timewait 一栏",
			"cat /proc/sys/net/ipv4/ip_local_port_range       # 你的临时端口范围",
		},
		Win: []string{
			psGroupRemote(port) + "   # 远端端口是 " + port + " → 客户端侧",
			"netsh int ipv4 show dynamicport tcp              # 你的临时端口范围",
		},
		Expect: []string{
			"不加 -passive：客户端侧 TIME_WAIT ≈ 已完成的连接数，服务端侧接近 0",
			"加了 -passive ：两侧都几乎没有 TIME_WAIT（若服务端是 server-timewait，则堆在服务端）",
			"每条 TIME_WAIT 的本地端口都不一样 —— 它们正是被临时占住的临时端口",
		},
		Why: []string{
			"TIME_WAIT 堆在主动关闭方；客户端主动关，就堆在客户端",
			"客户端侧 TIME_WAIT 会吃临时端口，这才是'高并发外呼撞墙'的真正机制",
		},
	}.print()

	var (
		ok, failed int
		byErr      = map[string]int{}
		ports      = map[string]struct{}{}
		start      = time.Now()
	)

loop:
	for i := 0; i < n; i++ {
		select {
		case <-ctx.Done():
			log.Printf("收到 Ctrl+C，提前停止（已完成 %d/%d）", i, n)
			break loop
		default:
		}

		local, err := oneShortConn(i, cfg.passive)
		if err != nil {
			failed++
			byErr[explainErr(err)]++
			// 端口耗尽这类错误一旦出现就会持续，打印前 5 条避免刷屏。
			if failed <= 5 {
				log.Printf("第 %d 条失败: %s", i+1, explainErr(err))
			}
		} else {
			ok++
			ports[local] = struct{}{}
		}
		if cfg.delay > 0 {
			time.Sleep(cfg.delay)
		}
		if (i+1)%100 == 0 {
			log.Printf("进度 %d/%d（成功 %d 失败 %d，已用不同临时端口 %d 个）", i+1, n, ok, failed, len(ports))
		}
	}

	elapsed := time.Since(start)
	rate := float64(ok) / elapsed.Seconds()

	fmt.Println()
	fmt.Println(sep)
	fmt.Println("【本次统计】")
	fmt.Printf("  成功 %d 条，失败 %d 条，耗时 %v\n", ok, failed, elapsed.Round(time.Millisecond))
	fmt.Printf("  建连速率 ≈ %.0f conn/s\n", rate)
	fmt.Printf("  用掉的不同临时端口 %d 个（≈ 成功数，说明每条连接都占了一个新端口）\n", len(ports))
	for e, c := range byErr {
		fmt.Printf("  失败原因 x%d：%s\n", c, e)
	}
	fmt.Println()
	if cfg.passive {
		fmt.Println("  本次是被动关闭方：本端不进 TIME_WAIT，临时端口立即可复用，没有端口耗尽风险。")
		fmt.Println("  → 这正是'把 TIME_WAIT 推给服务端'能缓解客户端端口压力的原因。")
	} else {
		fmt.Println("【临时端口耗尽推算】（稳态 TIME_WAIT 数 ≈ 建连速率 × 2MSL）")
		projectExhaustion(rate, "Linux  ", linuxEphemeralPorts, linuxTimeWaitSec)
		projectExhaustion(rate, "Windows", winEphemeralPorts, winTimeWaitSec)
		fmt.Println()
		fmt.Println("  ⚠️ 上面的上限是【对同一个目标 IP:端口】而言的；连不同下游时四元组不同，可以叠加。")
		fmt.Println("  ⚠️ 也正因为如此，'换个大机器'解决不了端口耗尽 —— 端口范围和机器规格无关。")
	}
	fmt.Println(sep)

	obs{
		Title: "跑完立刻看（TIME_WAIT 会留 60~120 秒）",
		Linux: []string{
			ssCountState("time-wait", "dport = :"+port),
			"# 隔 70 秒再敲一次，看它自己归零",
		},
		Win: []string{psGroupRemote(port)},
		Expect: []string{
			"客户端侧 TIME_WAIT ≈ " + fmt.Sprint(ok) + " 条（不加 -passive 时）",
			"等 60s（Linux）/ 120s（Windows）后复查，自行归零，无需任何干预",
		},
		Why: []string{
			"TIME_WAIT 是【设计如此的等待】，不是泄漏 —— 会自己走完，这点和 CLOSE_WAIT 截然相反",
			"看到 TIME_WAIT 先别慌：先看它在哪一侧、量级是不是逼近临时端口上限",
			"真正的修法是连接复用（长连接/连接池），把'每次请求一条连接'变成'一条连接跑很多请求'",
		},
	}.print()
	return nil
}

// oneShortConn 建立一条短连接，返回本端使用的临时端口。
func oneShortConn(seq int, passive bool) (string, error) {
	conn, err := net.DialTimeout("tcp", cfg.addr, dialTimeout)
	if err != nil {
		return "", err
	}
	// Close 的位置：拿到 conn 立刻 defer。
	// ⚠️ 不加 -passive 时，正是这个 Close 让本端成为主动关闭方 → 进 TIME_WAIT。
	//    加了 -passive 时，下面会先读到 io.EOF（对端已经关了），
	//    此时这个 Close 只是回一个 FIN，本端走 CLOSE_WAIT → LAST_ACK → CLOSED，不进 TIME_WAIT。
	defer conn.Close()

	local := portOf(conn.LocalAddr().String())

	if err := conn.SetWriteDeadline(time.Now().Add(rwTimeout)); err != nil {
		return local, err
	}
	msg := fmt.Sprintf("hello-%d\n", seq)
	if _, err := conn.Write([]byte(msg)); err != nil {
		return local, err
	}

	if err := conn.SetReadDeadline(time.Now().Add(rwTimeout)); err != nil {
		return local, err
	}
	if passive {
		// 一直读到 io.EOF：等对端先发 FIN，本端做被动关闭方。
		if _, err := io.Copy(io.Discard, conn); err != nil {
			return local, err
		}
		return local, nil
	}
	// 只把 echo 回来的这一份读掉，然后靠 defer Close 主动关闭。
	buf := make([]byte, len(msg))
	if _, err := io.ReadFull(conn, buf); err != nil {
		return local, err
	}
	return local, nil
}

func projectExhaustion(rate float64, name string, portRange int, twSec float64) {
	if rate <= 0 {
		fmt.Printf("  %s：速率为 0，无法推算\n", name)
		return
	}
	steady := rate * twSec                // 稳态下同时存在的 TIME_WAIT 数
	ceiling := float64(portRange) / twSec // 可持续的最大短连接速率
	verdict := "✅ 安全"
	if steady >= float64(portRange) {
		verdict = "❌ 会耗尽：持续这个速率，端口迟早不够用"
	} else if steady >= float64(portRange)*0.5 {
		verdict = "⚠️ 危险：已经吃掉一半以上的临时端口"
	}
	fmt.Printf("  %s：端口 %d 个 / 2MSL %.0fs → 可持续上限 ≈ %.0f conn/s；"+
		"按本次 %.0f conn/s 推算稳态 TIME_WAIT ≈ %.0f 条  %s\n",
		name, portRange, twSec, ceiling, rate, steady, verdict)
}

// ------------------------------------------------------------------
// client-close
// ------------------------------------------------------------------

// runClientClose：连一次、发一条消息、立刻主动 Close()，不等回包。
// 专门用来给 server-bad 喂料：客户端的 FIN 到达后，server-bad 不会 Close，
// 于是服务端那条连接永久停在 CLOSE_WAIT。
func runClientClose(ctx context.Context) error {
	n := nOr(1)
	port := portOf(cfg.addr)
	log.Printf("目标 %s，建立 %d 条连接：每条发一句话后立刻主动 Close（不等回包）", cfg.addr, n)

	var ok, failed int
loop:
	for i := 0; i < n; i++ {
		select {
		case <-ctx.Done():
			log.Printf("收到 Ctrl+C，提前停止（已完成 %d/%d）", i, n)
			break loop
		default:
		}
		if err := sendAndClose(i); err != nil {
			failed++
			log.Printf("第 %d 条失败: %s", i+1, explainErr(err))
		} else {
			ok++
		}
	}
	log.Printf("完成：成功 %d 条，失败 %d 条", ok, failed)
	if n == 1 {
		log.Printf("提示：想看堆积效果就加 -n 20，一次制造 20 条 CLOSE_WAIT")
	}

	obs{
		Title: "对面跑 server-bad 时，去看服务端侧的 CLOSE_WAIT",
		Linux: []string{
			ssCountState("close-wait", "sport = :"+port) + "   # 服务端侧：应为 " + fmt.Sprint(ok) + " 条（+1 是表头）",
			ssCountState("fin-wait-2", "dport = :"+port) + "   # 客户端侧：被对端拖住的另一半",
		},
		Win: []string{
			psGroup(port),
			psGroupRemote(port),
		},
		Expect: []string{
			"对面是 server-bad：服务端侧 CLOSE_WAIT = " + fmt.Sprint(ok) + " 条，本进程都退出了它还在",
			"对面是 server-good：什么都看不到，连接秒退（这就是对照组的意义）",
			"客户端侧对应有 FIN_WAIT_2（我方 FIN 已被 ACK，但在等对方的 FIN）",
		},
		Why: []string{
			"客户端进程都没了，服务端的 CLOSE_WAIT 还在 → 证明这个状态由服务端的代码决定，与客户端无关",
			"CLOSE_WAIT + 对端 FIN_WAIT_2 成对出现：你不 Close，上游的 fd 也跟着漏",
			"⚠️ Linux 上孤儿 FIN_WAIT_2 会被 tcp_fin_timeout（默认 60s）回收，但 CLOSE_WAIT 侧没有任何超时兜底",
		},
	}.print()
	return nil
}

func sendAndClose(seq int) error {
	conn, err := net.DialTimeout("tcp", cfg.addr, dialTimeout)
	if err != nil {
		return err
	}
	// Close 的位置：defer 在入口。这个 Close 发出 FIN，
	// 是整条 CLOSE_WAIT 实验的"扳机"。
	defer conn.Close()

	if err := conn.SetWriteDeadline(time.Now().Add(rwTimeout)); err != nil {
		return err
	}
	if _, err := conn.Write([]byte(fmt.Sprintf("bye-%d\n", seq))); err != nil {
		return err
	}
	// ⚠️ 故意不读回包：真实场景里客户端超时放弃、用户取消请求，都是这个形态。
	//    写完就关，服务端能不能正确善后，全看服务端自己。
	return nil
}
