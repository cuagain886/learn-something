// 03_workdir_lifecycle — 任务工作目录：创建、配额、三层清理
//
// 学什么：
//  1. 每任务一个随机命名的隔离目录（防碰撞、防预测）
//  2. 配额三件套：单文件大小 / 目录总大小 / 文件数量（防 inode 耗尽）
//  3. ⚠️ 清理必须三层，缺一不可：
//     ① defer      —— 正常路径 + panic
//     ② 信号处理    —— SIGTERM 时统一清理所有活跃任务（第 02 章优雅退出）
//     ③ 启动扫孤儿  —— 上次被 SIGKILL 时 defer 根本没机会执行，只能事后打扫
//
// 运行：cd os/code && go run ./04_io/03_workdir_lifecycle
package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Quota 定义单个任务的磁盘配额
type Quota struct {
	MaxFileSize  int64 // 单文件上限
	MaxTotalSize int64 // 目录总量上限
	MaxFiles     int   // 文件数上限（防生成百万小文件耗尽 inode）
}

var ErrQuotaExceeded = errors.New("quota exceeded")

// Workspace 是一个任务的隔离工作目录
type Workspace struct {
	Dir       string
	quota     Quota
	usedBytes int64
	fileCount int
}

// NewWorkspace 创建隔离目录。
// MkdirTemp 的随机后缀有两个作用：防止任务 ID 冲突；防止攻击者预测路径提前埋符号链接。
func NewWorkspace(base, taskID string, q Quota) (*Workspace, error) {
	if err := os.MkdirAll(base, 0o755); err != nil {
		return nil, err
	}
	dir, err := os.MkdirTemp(base, "task-"+taskID+"-*")
	if err != nil {
		return nil, err
	}
	// 0700: 只有属主可读写进入。多租户场景还要配合独立 uid（第 11 章）
	if err := os.Chmod(dir, 0o700); err != nil {
		os.RemoveAll(dir)
		return nil, err
	}
	return &Workspace{Dir: dir, quota: q}, nil
}

// WriteFile 带配额检查的写入。真实 Runner 里工具是直接写盘的，
// 应用层计数只是【软防线】——硬限制要靠 cgroup io / 文件系统 quota（第 11 章）。
func (w *Workspace) WriteFile(name string, r io.Reader) (int64, error) {
	if w.fileCount >= w.quota.MaxFiles {
		return 0, fmt.Errorf("%w: 文件数已达上限 %d", ErrQuotaExceeded, w.quota.MaxFiles)
	}
	// ⚠️ 这里必须做路径校验（见 02_safe_path），否则 name="../../evil" 就逃出去了
	if strings.Contains(name, "..") || filepath.IsAbs(name) {
		return 0, errors.New("非法文件名")
	}

	remainTotal := w.quota.MaxTotalSize - w.usedBytes
	limit := min(w.quota.MaxFileSize, remainTotal)
	if limit <= 0 {
		return 0, fmt.Errorf("%w: 目录总量已达上限", ErrQuotaExceeded)
	}

	f, err := os.OpenFile(filepath.Join(w.Dir, name),
		os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600) // O_EXCL: 不允许覆盖已有文件
	if err != nil {
		return 0, err
	}
	defer f.Close()

	// LimitReader 让写入在配额处自然截断，而不是先写爆再回滚
	n, err := io.Copy(f, io.LimitReader(r, limit+1))
	if n > limit {
		os.Remove(filepath.Join(w.Dir, name)) // 超限就整个丢弃，不留半截文件
		return 0, fmt.Errorf("%w: 单文件超过 %d 字节", ErrQuotaExceeded, limit)
	}
	w.usedBytes += n
	w.fileCount++
	return n, err
}

// Cleanup 是清理的【第一层】：defer 调用，覆盖正常返回和 panic
func (w *Workspace) Cleanup() error { return os.RemoveAll(w.Dir) }

// CleanOrphans 是清理的【第三层】：启动时扫描，回收上次崩溃遗留的目录。
// 判据用修改时间：超过 maxAge 还在的，一定不是本次启动创建的活跃任务。
func CleanOrphans(base string, maxAge time.Duration) (removed int, err error) {
	entries, err := os.ReadDir(base)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	cutoff := time.Now().Add(-maxAge)
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), "task-") {
			continue
		}
		info, err := e.Info()
		if err != nil || info.ModTime().After(cutoff) {
			continue // 还新，可能是活跃任务，不动
		}
		if os.RemoveAll(filepath.Join(base, e.Name())) == nil {
			removed++
		}
	}
	return removed, nil
}

func main() {
	base := filepath.Join(os.TempDir(), "runner-workdirs")
	defer os.RemoveAll(base)

	fmt.Println("== 第三层清理: 启动时扫孤儿目录 ==")
	// 先伪造两个"上次崩溃遗留"的目录
	os.MkdirAll(filepath.Join(base, "task-old-1"), 0o755)
	os.MkdirAll(filepath.Join(base, "task-old-2"), 0o755)
	old := time.Now().Add(-2 * time.Hour)
	os.Chtimes(filepath.Join(base, "task-old-1"), old, old)
	os.Chtimes(filepath.Join(base, "task-old-2"), old, old)

	n, _ := CleanOrphans(base, time.Hour)
	fmt.Printf("  回收了 %d 个超过 1 小时的孤儿目录 ✅\n", n)
	fmt.Println("  （SIGKILL 时 defer 不会执行，这一层是唯一的兜底）")
	fmt.Println()

	fmt.Println("== 正常任务: 创建 → 写入 → 清理 ==")
	q := Quota{MaxFileSize: 1 << 20, MaxTotalSize: 4 << 20, MaxFiles: 3}
	ws, err := NewWorkspace(base, "abc123", q)
	if err != nil {
		panic(err)
	}
	fmt.Printf("  工作目录: %s (权限 0700)\n", ws.Dir)

	written, err := ws.WriteFile("output.log", strings.NewReader("正常的工具输出\n"))
	fmt.Printf("  写 output.log: %d 字节, err=%v\n", written, err)

	fmt.Println("\n== 配额防线 ==")
	// 超单文件大小：2MB > MaxFileSize 1MB
	_, err = ws.WriteFile("huge.bin", io.LimitReader(zeroReader{}, 2<<20))
	fmt.Printf("  写 2MB 文件(限 1MB):  %v\n", err)

	// 超文件数：已有 1 个，配额 3 个
	for i := 0; i < 3; i++ {
		_, err = ws.WriteFile(fmt.Sprintf("f%d.txt", i), strings.NewReader("x"))
		if err != nil {
			fmt.Printf("  写第 %d 个文件(限 3 个):  %v\n", i+2, err)
			break
		}
	}

	// 重名文件：O_EXCL 拒绝覆盖
	_, err = ws.WriteFile("output.log", strings.NewReader("覆盖尝试"))
	fmt.Printf("  重名覆盖(O_EXCL):     %v\n", err)

	// 路径穿越尝试
	_, err = ws.WriteFile("../../escape.txt", strings.NewReader("逃逸"))
	fmt.Printf("  路径穿越 ../../:      %v\n", err)

	fmt.Println("\n== 第一层清理: defer Cleanup ==")
	ws.Cleanup()
	if _, err := os.Stat(ws.Dir); os.IsNotExist(err) {
		fmt.Println("  工作目录已删除 ✅")
	}

	fmt.Println(`
三层清理缺一不可:
  ① defer Cleanup()          正常返回 + panic     → 覆盖 95% 情况
  ② SIGTERM handler 统一清理  优雅退出            → 覆盖部署/重启
  ③ 启动时 CleanOrphans      SIGKILL/断电/OOM    → 唯一的兜底
配额同样分层: 应用层计数(软) → cgroup io + 文件系统 quota(硬, 第 11 章)
另: 把 base 挂成 tmpfs 可以天然获得大小上限 + 卸载即彻底清理。`)
}

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) { return len(p), nil }
