// 03_tcp_states —— 把 TCP 状态机用真实流量"跑"出来
//
// ================================ 本节概览 ================================
//
// 【这个程序演示什么】
//
//	配套知识章节：net/knowledge/05_tcp_connection.md（TCP 连接管理与状态机）。
//	八股文背过的 TIME_WAIT / CLOSE_WAIT / RST / 半关闭（half-close），
//	在这里全部变成可复现的现象：一个终端跑程序，另一个终端用 ss（Linux/WSL2）
//	或 Get-NetTCPConnection（Windows PowerShell）盯着内核里的连接状态看。
//
//	目标不是"知道有这么个状态"，而是"线上看到这个状态，能立刻说出谁的锅"。
//
// 【怎么运行】
//
//	go run . -h                                  # 列出全部子命令与 flag
//	go run . -mode server-bad                    # 终端 A：故障服务端
//	go run . -mode client-close -n 20            # 终端 B：制造 20 条 CLOSE_WAIT
//	go run . -mode rst                           # 单终端即可，无需配合
//	go run . -mode halfclose                     # 单终端即可，无需配合
//
//	子命令分两类：
//	  · 单终端自足型（rst / halfclose）—— 进程内自带对端，跑完自己打印结论
//	  · 双终端配合型（server-* + client-*）—— 先起 server，再起 client
//
// 【预期观察到什么】
//
//	每个子命令启动时和结束时都会打印一块「观察点」：该敲哪条命令、预期看到
//	什么、由此能推出什么结论。跑之前先读，跑之后逐条对照——对不上就是理解
//	有偏差，回知识章节。
//
// 【Java 程序员视角】
//
//	Go 的 conn.Close() ≈ Java Socket.close()；
//	Go 的 conn.CloseWrite() ≈ Java SocketChannel.shutdownOutput()（半关闭）；
//	Go 的 SetLinger(0) ≈ Java Socket.setSoLinger(true, 0)。
//	"CLOSE_WAIT 堆积"在 Java 里同样是漏了 close() 或 try-with-resources
//	没覆盖到异常路径。语言不同，内核完全一样——这也是为什么排障要看状态机
//	而不是看框架文档。
//
// 【全局 flag 速查】
//
//	-mode     选子命令（必填）
//	-addr     服务端监听地址 / 客户端连接地址，默认 127.0.0.1:9000
//	-n        连接条数，0 表示用子命令自己的默认值
//	-hold     server-bad 模拟"卡在下游调用"的时长，默认 10m
//	-idle     server-good 的读空闲超时，默认 2m
//	-delay    client-timewait 每条连接之间的间隔，默认 0（打满）
//	-passive  client-timewait 改为被动关闭方（等对端先发 FIN）
//
// =========================================================================
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"strings"
	"time"
)

// config 是所有子命令共用的一组参数。
// 只用一组全局 flag（而不是每个子命令一个 FlagSet），是为了让读者
// 敲命令时不用记"哪个 mode 支持哪些 flag"——不相关的 flag 忽略即可。
type config struct {
	addr    string
	n       int
	hold    time.Duration
	idle    time.Duration
	delay   time.Duration
	passive bool
}

var cfg config

type command struct {
	name  string
	brief string   // 一句话说明，出现在 -h 列表里
	intro []string // 启动横幅里的详细说明：这个子命令在演示什么
	run   func(ctx context.Context) error
}

// ⚠️ 这里的 run 字段只能引用不反向依赖 commands 的函数，
// 否则会构成包级变量初始化循环（Go 编译期直接报错）。
var commands = []command{
	{
		name:  "server-good",
		brief: "【对照组】正常 echo 服务端：读到 io.EOF 立刻 Close()",
		intro: []string{
			"Read 返回 io.EOF = 收到对端的 FIN，本端此刻进入 CLOSE_WAIT。",
			"因为 handler 入口就 defer Close()，CLOSE_WAIT 只存在几微秒，",
			"ss 里基本抓不到——这才是健康服务端该有的样子。",
		},
		run: runServerGood,
	},
	{
		name:  "server-bad",
		brief: "【复现 CLOSE_WAIT 堆积】只读一次、卡在下游、永不 Close",
		intro: []string{
			"模拟最经典的连接泄漏：handler 读了一次请求就阻塞在下游调用上，",
			"对端早就 close 了（FIN 已到达），本端却一直不 Close()。",
			"内核只能把连接钉在 CLOSE_WAIT，数量只增不减，直到 fd 耗尽。",
		},
		run: runServerBad,
	},
	{
		name:  "server-timewait",
		brief: "【复现服务端侧 TIME_WAIT】服务端应答完立刻主动 Close()",
		intro: []string{
			"服务端回完一条响应就主动关闭（等价于 HTTP 的 Connection: close）。",
			"主动关闭方进 TIME_WAIT —— 所以这次 TIME_WAIT 堆在服务端。",
			"配合 client-timewait -passive 使用，客户端做被动关闭方。",
		},
		run: runServerTimeWait,
	},
	{
		name:  "client-timewait",
		brief: "【复现客户端侧 TIME_WAIT】快速打 N 条短连接，客户端主动 Close()",
		intro: []string{
			"默认 500 条短连接，每条发一句话、收一句话、客户端主动 Close()。",
			"主动关闭方进 TIME_WAIT，所以 TIME_WAIT 堆在客户端侧。",
			"跑完会按实测速率推算：这个速率能不能撑住、多久临时端口耗尽。",
		},
		run: runClientTimeWait,
	},
	{
		name:  "client-close",
		brief: "配合 server-bad：连一次、发一条消息、立刻主动 Close()",
		intro: []string{
			"客户端发完就关，不等回包。对 server-good 来说这条连接秒退；",
			"对 server-bad 来说，它会在服务端留下一条永久的 CLOSE_WAIT。",
			"想看堆积效果就加 -n 20。",
		},
		run: runClientClose,
	},
	{
		name:  "rst",
		brief: "【RST 三连】connection refused / reset by peer / 写已关闭的连接",
		intro: []string{
			"单终端跑，进程内自带对端。三个场景对应线上三种最常见的错误信息，",
			"每个场景都会打印原始 error + errno 数字 + 中文含义。",
		},
		run: runRST,
	},
	{
		name:  "halfclose",
		brief: "【半关闭】CloseWrite() 之后还能收响应，Close() 直接全断",
		intro: []string{
			"单终端跑。同一个请求-响应流程做两遍：一遍用 CloseWrite()（正确），",
			"一遍用 Close()（错误），对比客户端能不能拿到服务端的响应。",
		},
		run: runHalfClose,
	},
}

func lookup(name string) *command {
	for i := range commands {
		if commands[i].name == name {
			return &commands[i]
		}
	}
	return nil
}

func main() {
	// 时间戳精确到微秒：TCP 状态迁移是亚毫秒级的，秒级时间戳看不出先后。
	// 统一输出到 stdout，避免 log(stderr) 和提示信息(stdout) 在终端里乱序。
	log.SetFlags(log.Ltime | log.Lmicroseconds)
	log.SetOutput(os.Stdout)

	mode := flag.String("mode", "", "子命令名，见下方列表")
	flag.StringVar(&cfg.addr, "addr", "127.0.0.1:9000", "服务端监听地址 / 客户端连接地址")
	flag.IntVar(&cfg.n, "n", 0, "连接条数（0 = 用子命令默认值：client-timewait 500，client-close 1）")
	flag.DurationVar(&cfg.hold, "hold", 10*time.Minute, "server-bad 里模拟下游阻塞的时长")
	flag.DurationVar(&cfg.idle, "idle", 2*time.Minute, "server-good 的读空闲超时（Deadline）")
	flag.DurationVar(&cfg.delay, "delay", 0, "client-timewait 每条连接之间的间隔")
	flag.BoolVar(&cfg.passive, "passive", false, "client-timewait：等对端先发 FIN 再 Close（本端做被动关闭方）")
	flag.Usage = usage
	flag.Parse()

	if *mode == "" {
		usage()
		os.Exit(2)
	}
	cmd := lookup(*mode)
	if cmd == nil {
		fmt.Fprintf(os.Stderr, "未知的 -mode %q\n\n", *mode)
		usage()
		os.Exit(2)
	}
	if _, _, err := net.SplitHostPort(cfg.addr); err != nil {
		fmt.Fprintf(os.Stderr, "-addr %q 不是合法的 host:port：%v\n", cfg.addr, err)
		os.Exit(2)
	}

	// Ctrl+C 不是"杀进程"，而是取消 ctx：
	// 服务端据此关闭 Listener、打印收尾统计，让读者看到优雅关闭的过程。
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	banner(cmd)
	if err := cmd.run(ctx); err != nil {
		// context.Canceled 是 Ctrl+C 的正常退出路径，不算错误。
		if errors.Is(err, context.Canceled) {
			return
		}
		log.Fatalf("[%s] 异常退出: %s", cmd.name, explainErr(err))
	}
}

func usage() {
	w := flag.CommandLine.Output()
	fmt.Fprintln(w, "03_tcp_states —— 复现 TCP 状态机（TIME_WAIT / CLOSE_WAIT / RST / 半关闭）")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "用法: go run . -mode <子命令> [flags]")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "子命令:")
	for _, c := range commands {
		fmt.Fprintf(w, "  %-16s %s\n", c.name, c.brief)
	}
	fmt.Fprintln(w)
	fmt.Fprintln(w, "flags:")
	flag.PrintDefaults()
	fmt.Fprintln(w)
	fmt.Fprintln(w, "典型组合:")
	fmt.Fprintln(w, "  # 复现 CLOSE_WAIT 堆积（两个终端）")
	fmt.Fprintln(w, "  终端A: go run . -mode server-bad")
	fmt.Fprintln(w, "  终端B: go run . -mode client-close -n 20")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "  # 复现客户端侧 TIME_WAIT（两个终端）")
	fmt.Fprintln(w, "  终端A: go run . -mode server-good")
	fmt.Fprintln(w, "  终端B: go run . -mode client-timewait -n 500")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "  # 复现服务端侧 TIME_WAIT（两个终端）")
	fmt.Fprintln(w, "  终端A: go run . -mode server-timewait")
	fmt.Fprintln(w, "  终端B: go run . -mode client-timewait -passive -n 300")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "  # 不需要配合，单终端直接跑")
	fmt.Fprintln(w, "  go run . -mode rst")
	fmt.Fprintln(w, "  go run . -mode halfclose")
}

func banner(c *command) {
	fmt.Println()
	fmt.Println(sep)
	fmt.Printf("  子命令: %s\n", c.name)
	fmt.Printf("  作用  : %s\n", c.brief)
	for _, line := range c.intro {
		fmt.Printf("          %s\n", line)
	}
	fmt.Println(sep)
	fmt.Println()
}

// nOr 返回 -n 的值；没显式指定（0）时用子命令自己的默认值。
func nOr(def int) int {
	if cfg.n > 0 {
		return cfg.n
	}
	return def
}

// portOf 从 "host:port" 里取端口，用于拼观察命令。
func portOf(addr string) string {
	_, p, err := net.SplitHostPort(addr)
	if err != nil {
		return strings.TrimPrefix(addr, ":")
	}
	return p
}
