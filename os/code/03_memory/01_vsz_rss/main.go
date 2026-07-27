//go:build linux

// 01_vsz_rss — 亲眼看懂"承诺 vs 交割"：VSZ、RSS 与 demand paging
//
// 学什么：
//  1. mmap 1GB 匿名内存后：VSZ(承诺) 立涨 1GB，RSS(实际驻留) 纹丝不动
//  2. 逐页写入(touch)时：每页触发一次 minor page fault，RSS 阶梯上涨
//  3. madvise(MADV_DONTNEED) 归还后：RSS 回落，VSZ 不变(合同还在, 页没了)
//     ⚠️ 这就是"用 VSZ 报警毫无意义"和"Linux 分配成功≠内存存在"的实证
//
// 运行：cd os/code && go run ./03_memory/01_vsz_rss   （仅 Linux/WSL2）
package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
)

// procMem 读 /proc/self/status 里的 VmSize(VSZ)/VmRSS，单位 KB
func procMem() (vsz, rss int) {
	raw, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return 0, 0
	}
	for _, line := range strings.Split(string(raw), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		v, _ := strconv.Atoi(f[1])
		switch {
		case strings.HasPrefix(line, "VmSize:"):
			vsz = v
		case strings.HasPrefix(line, "VmRSS:"):
			rss = v
		}
	}
	return
}

// minorFaults 读 /proc/self/stat 第 10 字段（minflt，本进程 minor fault 累计数）
func minorFaults() int {
	raw, err := os.ReadFile("/proc/self/stat")
	if err != nil {
		return 0
	}
	s := string(raw)
	fields := strings.Fields(s[strings.LastIndexByte(s, ')')+2:])
	// 去掉 pid+comm 后：fields[0]=state ... minflt 是原始第10字段 → 这里下标 7
	if len(fields) > 7 {
		n, _ := strconv.Atoi(fields[7])
		return n
	}
	return 0
}

func report(stage string, baseVsz, baseRss, baseFlt int) {
	vsz, rss := procMem()
	fmt.Printf("%-34s VSZ=%+6d MB   RSS=%+6d MB   minor_fault=%+d\n",
		stage, (vsz-baseVsz)/1024, (rss-baseRss)/1024, minorFaults()-baseFlt)
}

func main() {
	const size = 1 << 30 // 1GB
	baseVsz, baseRss := procMem()
	baseFlt := minorFaults()
	fmt.Println("（下列数字均为相对启动时的增量）")
	report("① 基线", baseVsz, baseRss, baseFlt)

	// mmap 1GB 匿名私有内存 —— 只签合同(建 VMA)，不给一页真内存
	mem, err := syscall.Mmap(-1, 0, size,
		syscall.PROT_READ|syscall.PROT_WRITE,
		syscall.MAP_ANON|syscall.MAP_PRIVATE)
	if err != nil {
		panic(err)
	}
	defer syscall.Munmap(mem)
	report("② mmap 1GB 后(承诺)", baseVsz, baseRss, baseFlt)

	// 写前 256MB：每 4KB 页 touch 一个字节 → 每页一次 minor fault → 内核才交割物理页
	pageSize := os.Getpagesize()
	for off := 0; off < size/4; off += pageSize {
		mem[off] = 1
	}
	report("③ 逐页写入 256MB 后(交割)", baseVsz, baseRss, baseFlt)
	fmt.Printf("   （minor fault 增量 ≈ 256MB/%dKB = %d 次——每页一次缺页）\n",
		pageSize/1024, size/4/pageSize)

	// 再写 256MB
	for off := size / 4; off < size/2; off += pageSize {
		mem[off] = 1
	}
	report("④ 累计写入 512MB 后", baseVsz, baseRss, baseFlt)

	// MADV_DONTNEED：告诉内核"这些页我不要了"——物理页立即回收，RSS 掉，VSZ 不变
	// （Go runtime 的 scavenger 归还内存用的正是这一族调用，见 06 章 2.5）
	if err := syscall.Madvise(mem, syscall.MADV_DONTNEED); err != nil {
		panic(err)
	}
	report("⑤ MADV_DONTNEED 归还后", baseVsz, baseRss, baseFlt)
	fmt.Println("\n结论: VSZ=合同额, RSS=已交割。报警看 RSS, 泄漏分析看 heap profile,")
	fmt.Println("      VSZ 只在'地址空间要耗尽'这种罕见病里才有意义。")
}
