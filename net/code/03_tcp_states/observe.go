// observe.go —— 公共工具：观察点提示 + 错误码翻译
//
// 【这个文件干什么】
//
//  1. obs：统一格式打印「现在该去另一个终端看什么 / 预期看到什么 / 结论是什么」。
//     这是本示例的核心——代码只负责制造现象，结论必须由读者亲眼在 ss 里确认。
//  2. explainErr：把 Go 的网络 error 翻译成"底层发生了什么事件"。
//     排障时最值钱的不是错误字符串本身，而是它背后对应的 TCP 报文。
//
// 【为什么单独抽一个文件】
//
//	所有子命令都要打印观察点、都要解释错误，避免七份重复代码。
package main

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"syscall"
)

const sep = "──────────────────────────────────────────────────────────────────────"

// obs 描述一个"观察点"：跑到这一步，去另一个终端敲什么、看什么、想明白什么。
type obs struct {
	Title  string   // 这个观察点在看什么
	Linux  []string // Linux / WSL2 命令
	Win    []string // Windows PowerShell 命令
	Expect []string // 预期看到的现象
	Why    []string // 由现象推出的结论
}

func (o obs) print() {
	fmt.Println()
	fmt.Println(sep)
	fmt.Printf("【观察点】%s\n", o.Title)
	if len(o.Linux) > 0 || len(o.Win) > 0 {
		fmt.Println("  现在去另一个终端执行观察命令：")
		for _, c := range o.Linux {
			fmt.Printf("    Linux/WSL2 : %s\n", c)
		}
		for _, c := range o.Win {
			fmt.Printf("    Windows    : %s\n", c)
		}
	}
	if len(o.Expect) > 0 {
		fmt.Println("  预期看到：")
		for _, e := range o.Expect {
			fmt.Printf("    · %s\n", e)
		}
	}
	if len(o.Why) > 0 {
		fmt.Println("  结论：")
		for _, w := range o.Why {
			fmt.Printf("    → %s\n", w)
		}
	}
	fmt.Println(sep)
	fmt.Println()
}

// ssAll 返回"看某端口相关的全部连接"的 ss 命令。
// ⚠️ 本机自测（127.0.0.1）时客户端和服务端在同一台机器上，
// 同一条 ss 输出里会同时出现两侧的记录——必须用 sport/dport 区分谁是谁：
//
//	sport = :9000  → 本地端口是 9000  → 服务端侧
//	dport = :9000  → 对端端口是 9000  → 客户端侧
func ssAll(port string) string {
	return fmt.Sprintf("ss -tan '( sport = :%s or dport = :%s )'", port, port)
}

// ssCountState 统计某一侧处于某状态的连接数。
// state 取值：established / close-wait / time-wait / fin-wait-1 / fin-wait-2 / last-ack / syn-sent
func ssCountState(state, portExpr string) string {
	return fmt.Sprintf("ss -tan state %s '( %s )' | wc -l", state, portExpr)
}

// psGroup 是 Windows 下"按状态分组计数"的等价命令。
// ⚠️ Get-NetTCPConnection 的 State 取值是驼峰式（Established / CloseWait /
// TimeWait / FinWait1 / FinWait2 / LastAck），和 ss 的写法不一样。
func psGroup(port string) string {
	return fmt.Sprintf("Get-NetTCPConnection -LocalPort %s -ErrorAction SilentlyContinue | Group-Object State", port)
}

func psGroupRemote(port string) string {
	return fmt.Sprintf("Get-NetTCPConnection -RemotePort %s -ErrorAction SilentlyContinue | Group-Object State", port)
}

// ------------------------------------------------------------------
// 错误码翻译
// ------------------------------------------------------------------

// ⚠️ 跨平台大坑：Windows 上 errors.Is(err, syscall.ECONNREFUSED) 恒为 false。
//
//	Linux/macOS：ECONNREFUSED 就是真实 errno（Linux 上是 111）；
//	Windows    ：真实错误码是 WSAECONNREFUSED = 10061，而 syscall.ECONNREFUSED
//	             在 Windows 上是 Go "凭空造"出来的占位值（536870934），
//	             两者对不上，errors.Is 自然返回 false。
//
// 所以这里的做法是：先用 errors.Is 走 Unix 路径，再用数字比对兜 Windows 路径。
// 线上写错误判断逻辑时，如果服务同时要跑 Linux 容器和 Windows 开发机，这个坑必踩。
const (
	wsaeConnAborted = 10053 // WSAECONNABORTED：连接被本机协议栈中止
	wsaeConnReset   = 10054 // WSAECONNRESET  ：收到 RST
	wsaeTimedOut    = 10060 // WSAETIMEDOUT   ：连接超时（对端无响应）
	wsaeConnRefused = 10061 // WSAECONNREFUSED：目标端口无人监听
	wsaeAddrInUse   = 10048 // WSAEADDRINUSE  ：地址已被占用
)

// explainErr 把 error 翻译成"底层发生了什么"。
// 排障口诀（本示例会把这四种全部复现一遍）：
//
//	connection refused      → 对端回了 RST，那个端口根本没人 listen（服务没起 / 端口写错）
//	connection reset by peer→ 收到 RST，连接在对端已不存在（进程崩了 / SO_LINGER=0 / 中间设备踢了）
//	broken pipe             → 往一个已经收到 RST 的连接上写（对端先没的，你后知后觉）
//	i/o timeout             → 你自己设的 Deadline 到了，网络层什么都没说
func explainErr(err error) string {
	if err == nil {
		return "<nil>"
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return "io.EOF —— 对端正常发了 FIN（四次挥手第一步），本端此刻进入 CLOSE_WAIT"
	}
	// ⚠️ 先于 errno 判断：Deadline 触发的错误在有些平台上也带 errno，
	// 但它是"我们自己踩的刹车"，和网络故障完全是两回事。
	if errors.Is(err, os.ErrDeadlineExceeded) {
		return "i/o timeout —— 【我们自己设的 Deadline】到期，不是对端或网络报的错"
	}
	if errors.Is(err, net.ErrClosed) {
		return "use of closed network connection —— 本端 Close() 之后还在用这个 Conn（代码 bug，不是网络问题）"
	}

	var errno syscall.Errno
	if errors.As(err, &errno) {
		n := uintptr(errno)
		switch {
		case errors.Is(err, syscall.ECONNREFUSED) || n == wsaeConnRefused:
			return fmt.Sprintf("connection refused (errno=%d) —— 对端内核直接回 RST：那个端口没人 listen", n)
		case errors.Is(err, syscall.ECONNRESET) || n == wsaeConnReset:
			return fmt.Sprintf("connection reset by peer (errno=%d) —— 收到 RST：连接在对端已不存在（崩溃 / SO_LINGER=0 / 被中间设备回收）", n)
		case errors.Is(err, syscall.EPIPE):
			return fmt.Sprintf("broken pipe (errno=%d) —— 往一个已经收到过 RST 的连接上写", n)
		case errors.Is(err, syscall.ECONNABORTED) || n == wsaeConnAborted:
			// ⚠️ Windows 上"往已被 RST 的连接写"经常报 10053 而不是 10054，
			//    取决于 RST 到达和这次 send 调用的先后。语义上和 ECONNRESET 是一回事。
			return fmt.Sprintf("connection aborted (errno=%d) —— 连接被本机协议栈中止（Windows 上常见于'往已被 RST 的连接继续写'，等价于 ECONNRESET）", n)
		case errors.Is(err, syscall.ETIMEDOUT) || n == wsaeTimedOut:
			return fmt.Sprintf("connection timed out (errno=%d) —— SYN 或数据反复重传都没等到 ACK（防火墙 DROP / 对端宕机）", n)
		case errors.Is(err, syscall.EADDRINUSE) || n == wsaeAddrInUse:
			return fmt.Sprintf("address already in use (errno=%d) —— 端口被占用，或临时端口耗尽（TIME_WAIT 太多）", n)
		}
		return fmt.Sprintf("%v (errno=%d，未归类)", err, n)
	}
	return err.Error()
}

// isTimeout 判断是不是超时类错误（含 Deadline 与内核超时）。
func isTimeout(err error) bool {
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

// shortErr 只取错误的最后一段，日志里刷屏时更好读。
func shortErr(err error) string {
	if err == nil {
		return "<nil>"
	}
	s := err.Error()
	if i := strings.LastIndex(s, ": "); i >= 0 && i+2 < len(s) {
		return s[i+2:]
	}
	return s
}
