//go:build unix

// 02_capture_output — 捕获 stdout/stderr：正确姿势与管道死锁复现
//
// 学什么：
//  1. 正确姿势：stdout、stderr 各配一个 goroutine 并发"排水"，全部读完(EOF)后才 Wait
//  2. ⚠️ 亲手复现经典死锁：管道是 64KB 定长内核缓冲——父进程先 Wait 不读，
//     子进程输出超过 64KB 后 write 永久阻塞，父子互相等 → 死锁
//  3. 为什么 Agent 必须同时读 stderr：python 异常栈、编译器告警全走 stderr，
//     只排 stdout 的 Runner 遇到刷 stderr 的工具一样卡死
//
// 运行：
//   go run ./01_process/02_capture_output              # 正确姿势
//   go run ./01_process/02_capture_output -deadlock    # 复现死锁（10 秒后自动解围并解说）
package main

import (
	"bufio"
	"flag"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"time"
)

// spewCmd 生成一个往 stdout 和 stderr 各写 200KB 的子进程（远超管道 64KB 容量）
func spewCmd() *exec.Cmd {
	script := `i=0
while [ $i -lt 3200 ]; do
  echo "stdout line $i padding-padding-padding-padding-padding"
  echo "stderr line $i padding-padding-padding-padding-padding" >&2
  i=$((i+1))
done
echo "child done"`
	return exec.Command("sh", "-c", script)
}

// drain 持续读一根管道直到 EOF——它就是"排水泵"。
// 返回读到的行数。真实 Runner 在这里做三件事：打标签转发、计数、超上限截断。
func drain(r io.Reader, tag string, wg *sync.WaitGroup, count *int) {
	defer wg.Done()
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1024*1024) // 行缓冲上限，防超长行撑爆内存
	for sc.Scan() {
		*count++ // 教学从简：demo 里丢弃内容只计数；真实场景转发给用户/日志
		_ = tag
	}
}

func correctWay() {
	fmt.Println("== 正确姿势：两根管道并发排水，排空后才 Wait ==")
	cmd := spewCmd()
	outPipe, err := cmd.StdoutPipe()
	if err != nil {
		panic(err)
	}
	errPipe, err := cmd.StderrPipe()
	if err != nil {
		panic(err)
	}
	if err := cmd.Start(); err != nil {
		panic(err)
	}

	var wg sync.WaitGroup
	var nOut, nErr int
	wg.Add(2)
	go drain(outPipe, "out", &wg, &nOut)
	go drain(errPipe, "err", &wg, &nErr)

	wg.Wait()                  // ① 先等两根管道读到 EOF（子进程写完并退出时管道自然 EOF）
	if err := cmd.Wait(); err != nil { // ② 再收尸——godoc 明确要求先读完再 Wait
		fmt.Println("wait err:", err)
	}
	fmt.Printf("子进程顺利结束：stdout %d 行, stderr %d 行, 无阻塞\n\n", nOut, nErr)
}

func deadlockWay() {
	fmt.Println("== ⚠️ 错误姿势：先 Wait 后读（且完全不读 stderr）==")
	fmt.Println("   子进程要写 200KB stderr，管道只有 64KB —— 看好了：")
	cmd := spewCmd()
	outPipe, _ := cmd.StdoutPipe()
	_, _ = cmd.StderrPipe() // 建了 stderr 管道却没人读 —— 死锁引信
	_ = cmd.Start()

	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }() // 错误顺序：没读就 Wait

	select {
	case err := <-done:
		fmt.Println("居然结束了？", err) // 不会走到这
	case <-time.After(10 * time.Second):
		fmt.Println("→ 10 秒了还卡着。此刻的真相：")
		fmt.Println("   子进程: 卡在 write——stdout/stderr 两根管道都没人排水，")
		fmt.Println("            先写满 64KB 的那根让它永久阻塞")
		fmt.Println("   父进程: 卡在 Wait()——等子进程退出")
		fmt.Println("   互相等待 = 死锁。修复：像 correctWay 那样并发排水两根管道")
		_ = cmd.Process.Kill() // 解围，别让 demo 真挂住
		<-done
		_, _ = io.ReadAll(outPipe)
	}
}

func main() {
	deadlock := flag.Bool("deadlock", false, "复现管道死锁")
	flag.Parse()
	if *deadlock {
		deadlockWay()
		return
	}
	correctWay()
	fmt.Println("提示：加 -deadlock 参数复现死锁版本")
}
