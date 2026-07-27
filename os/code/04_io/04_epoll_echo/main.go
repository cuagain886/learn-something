//go:build linux

// 04_epoll_echo — 裸 epoll 写一个 echo server：看清 netpoller 替你做了什么
//
// 学什么：
//  1. epoll 三件套的真实调用：epoll_create1 / epoll_ctl / epoll_wait
//  2. 非阻塞 fd + ET 模式 + 循环读到 EAGAIN —— Go netpoller 内部就是这套
//  3. 对比 net 包版本（-net 参数）：同样的功能，代码量差 5 倍，
//     ⚠️ 差的这部分就是 runtime 替你扛下的复杂度
//
// 运行（两个终端）：
//   go run ./04_io/04_epoll_echo          # 裸 epoll 版, 监听 :9099
//   go run ./04_io/04_epoll_echo -net     # net 包版, 对照阅读
//   # 另一个终端: nc localhost 9099   然后随便输入
//
// 观察系统调用差异：
//   strace -f -e trace=epoll_create1,epoll_ctl,epoll_wait,accept4,read,write go run ...
package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"syscall"
)

const addr = ":9099"

// ⚠️ Go 的 syscall.EPOLLET 被声明成 -0x80000000（有符号），直接放进 uint32 的
// EpollEvent.Events 会编译报 overflow。自己定义成无符号常量即可。
// （用 golang.org/x/sys/unix 的 unix.EPOLLET 没有这个问题）
const epollET uint32 = 1 << 31

// ---- 裸 epoll 版 ---------------------------------------------------------

func epollServer() {
	// 1. 建监听 socket（Go 的 net 包这一步也一样，只是藏起来了）
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatal(err)
	}
	defer ln.Close()
	tcpLn := ln.(*net.TCPListener)
	lnFile, err := tcpLn.File() // 拿到底层 fd
	if err != nil {
		log.Fatal(err)
	}
	defer lnFile.Close()
	lnFd := int(lnFile.Fd())

	// ⚠️ 关键 1: 设为非阻塞。epoll 说"就绪"时数据可能已被别人取走，
	// 阻塞 fd 会在 accept/read 处卡死整个事件循环。
	if err := syscall.SetNonblock(lnFd, true); err != nil {
		log.Fatal(err)
	}

	// 2. epoll_create1: 在内核里创建 eventpoll 对象（红黑树 + 就绪链表 + 等待队列）
	epfd, err := syscall.EpollCreate1(0)
	if err != nil {
		log.Fatal(err)
	}
	defer syscall.Close(epfd)

	// 3. epoll_ctl(ADD): 把监听 fd 注册进红黑树 —— 【一次注册，长期有效】
	//    这正是 epoll 相对 select 的核心优势（select 每次调用都要全量传入）
	if err := syscall.EpollCtl(epfd, syscall.EPOLL_CTL_ADD, lnFd, &syscall.EpollEvent{
		Events: syscall.EPOLLIN, // 监听可读（新连接到来 = 监听 fd 可读）
		Fd:     int32(lnFd),
	}); err != nil {
		log.Fatal(err)
	}

	fmt.Printf("裸 epoll echo server 监听 %s (epfd=%d, lnFd=%d)\n", addr, epfd, lnFd)
	fmt.Println("测试: nc localhost 9099    退出: Ctrl-C")

	events := make([]syscall.EpollEvent, 128)
	buf := make([]byte, 4096)

	for {
		// 4. epoll_wait: 只返回【就绪的】fd —— 复杂度 O(就绪数) 而非 O(总连接数)
		//    这就是 10 万连接只有 100 个活跃时，epoll 碾压 select 的原因
		n, err := syscall.EpollWait(epfd, events, -1) // -1 = 无限等待
		if err != nil {
			if err == syscall.EINTR { // 被信号打断，重试（Go runtime 的信号很多）
				continue
			}
			log.Fatal("epoll_wait:", err)
		}

		for i := 0; i < n; i++ {
			fd := int(events[i].Fd)

			if fd == lnFd {
				// 新连接：ET 模式下必须循环 accept 到 EAGAIN，
				// 否则一次 epoll_wait 期间到达的多个连接会漏掉
				for {
					connFd, _, err := syscall.Accept4(lnFd, syscall.SOCK_NONBLOCK)
					if err != nil {
						break // EAGAIN: 没有更多待接受的连接了
					}
					syscall.EpollCtl(epfd, syscall.EPOLL_CTL_ADD, connFd, &syscall.EpollEvent{
						// epollET = 边缘触发：只在状态变化时通知一次
						Events: syscall.EPOLLIN | epollET,
						Fd:     int32(connFd),
					})
					fmt.Printf("  [新连接] fd=%d\n", connFd)
				}
				continue
			}

			// ⚠️ 关键 2: ET 模式必须【循环读到 EAGAIN】。
			// 只读一次就返回的话，缓冲区剩余数据不会再触发事件 —— 连接静默卡死。
			// 这是自己写 epoll 最容易踩的坑，也是 ET 比 LT 难写的唯一原因。
			for {
				nr, err := syscall.Read(fd, buf)
				if nr > 0 {
					syscall.Write(fd, buf[:nr]) // echo 回去
					continue                     // 继续读，直到 EAGAIN
				}
				if nr == 0 { // 对端关闭
					fmt.Printf("  [断开] fd=%d\n", fd)
					syscall.EpollCtl(epfd, syscall.EPOLL_CTL_DEL, fd, nil)
					syscall.Close(fd)
					break
				}
				if err == syscall.EAGAIN { // 读干净了
					break
				}
				if err == syscall.EINTR {
					continue
				}
				// 真错误
				syscall.EpollCtl(epfd, syscall.EPOLL_CTL_DEL, fd, nil)
				syscall.Close(fd)
				break
			}
		}
	}
}

// ---- net 包版（对照）-----------------------------------------------------

func netServer() {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatal(err)
	}
	defer ln.Close()
	fmt.Printf("net 包 echo server 监听 %s —— 对比一下代码量\n", addr)

	for {
		conn, err := ln.Accept() // 底层: epoll 挂起 goroutine, 就绪后唤醒
		if err != nil {
			log.Println(err)
			continue
		}
		// 每连接一个 goroutine —— 因为 goroutine 只要 2KB 且阻塞不占线程,
		// 这个在 C 里荒谬的写法在 Go 里是最佳实践（第 03 章 + 第 08 章 §3）
		go func(c net.Conn) {
			defer c.Close()
			buf := make([]byte, 4096)
			for {
				n, err := c.Read(buf) // 看似阻塞，实为 gopark + netpoller 唤醒
				if err != nil {
					return
				}
				if _, err := c.Write(buf[:n]); err != nil {
					return
				}
			}
		}(conn)
	}
}

func main() {
	useNet := flag.Bool("net", false, "用 net 包版本对照")
	flag.Parse()

	fmt.Printf("(pid=%d, 可用 strace -p %d 观察系统调用)\n\n", os.Getpid(), os.Getpid())
	if *useNet {
		netServer()
		return
	}
	epollServer()
}
