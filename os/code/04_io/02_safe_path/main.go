// 02_safe_path — 路径穿越与符号链接攻击：三层防御逐层验证
//
// 学什么：
//  1. 攻击 A（路径穿越）：用户传 "../../etc/passwd" 读到 sandbox 外的文件
//  2. 攻击 B（符号链接）：在 sandbox 内建软链接指向外部，字符串检查完全看不出来
//  3. 三层防御：Clean+前缀校验 → EvalSymlinks 复查 → os.Root 内核级约束
//     ⚠️ 前两层都有 TOCTOU 窗口（检查完到打开前，攻击者可以换掉文件）
//        只有第三层（openat2 RESOLVE_BENEATH）是无窗口的
//
// 运行：cd os/code && go run ./04_io/02_safe_path
//   （符号链接部分在 Windows 上需要管理员权限或开发者模式，会自动跳过）
package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// ---- 第一层: 路径规范化 + 前缀校验 ---------------------------------------

// 挡住 "../"，挡不住符号链接
func resolveLayer1(root, userPath string) (string, error) {
	// filepath.Join 内部会调 Clean：把 a/../b 折叠成 b，把 ./ 去掉
	joined := filepath.Join(root, userPath)
	clean := filepath.Clean(joined)

	// ⚠️ 必须比较到分隔符，否则 /sandbox-evil 会通过 /sandbox 的前缀检查
	if clean != root && !strings.HasPrefix(clean, root+string(filepath.Separator)) {
		return "", errors.New("层1 拦截: 路径逃出 root")
	}
	return clean, nil
}

// ---- 第二层: 解析符号链接后复查 ------------------------------------------

func resolveLayer2(root, userPath string) (string, error) {
	clean, err := resolveLayer1(root, userPath)
	if err != nil {
		return "", err
	}
	// root 本身也可能含链接（如 macOS 的 /tmp → /private/tmp），要用解析后的 root 比
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	real, err := filepath.EvalSymlinks(clean) // 展开路径上的所有符号链接
	if err != nil {
		if os.IsNotExist(err) {
			return clean, nil // 文件还不存在（如创建新文件），层1 的结论有效
		}
		return "", err
	}
	if real != realRoot && !strings.HasPrefix(real, realRoot+string(filepath.Separator)) {
		return "", fmt.Errorf("层2 拦截: 符号链接指向外部 (%s)", real)
	}
	return real, nil
}

// ---- 第三层: os.Root（Go 1.24+，内核级约束，无 TOCTOU 窗口）---------------

func openLayer3(root, userPath string) error {
	r, err := os.OpenRoot(root) // 底层: openat2(RESOLVE_BENEATH) —— 内核保证不出 root
	if err != nil {
		return err
	}
	defer r.Close()
	f, err := r.Open(userPath) // 路径解析全程在内核里受约束
	if err != nil {
		return fmt.Errorf("层3 拦截: %w", err)
	}
	defer f.Close()
	return nil
}

func try(label, root, userPath string) {
	fmt.Printf("  %-42s ", label)

	l1, err1 := resolveLayer1(root, userPath)
	_, err2 := resolveLayer2(root, userPath)
	err3 := openLayer3(root, userPath)

	status := func(err error, okMsg string) string {
		if err != nil {
			return "拦截"
		}
		return okMsg
	}
	fmt.Printf("层1=%-4s 层2=%-4s 层3=%-4s",
		status(err1, "放行"), status(err2, "放行"), status(err3, "放行"))
	if err1 == nil && err2 != nil {
		fmt.Printf("   ← ⚠️ 层1 被绕过! 解析到 %s", l1)
	}
	fmt.Println()
}

func main() {
	// 搭建 sandbox：root/ 下有一个正常文件，和一个指向外部的符号链接
	root, err := os.MkdirTemp("", "sandbox-*")
	if err != nil {
		panic(err)
	}
	defer os.RemoveAll(root)
	root, _ = filepath.EvalSymlinks(root) // 规范化 root 自身

	outside, err := os.MkdirTemp("", "secrets-*")
	if err != nil {
		panic(err)
	}
	defer os.RemoveAll(outside)
	outside, _ = filepath.EvalSymlinks(outside)
	secretFile := filepath.Join(outside, "passwd")
	os.WriteFile(secretFile, []byte("root:x:0:0:模拟的敏感文件\n"), 0644)
	os.WriteFile(filepath.Join(root, "normal.txt"), []byte("正常数据\n"), 0644)

	// 攻击 B 的布置：在 sandbox 里放一个看起来无辜的符号链接
	symlinkOK := true
	if err := os.Symlink(secretFile, filepath.Join(root, "innocent.txt")); err != nil {
		symlinkOK = false
		fmt.Printf("(本环境无法创建符号链接: %v —— 跳过攻击 B)\n\n", err)
	}

	fmt.Printf("sandbox root = %s\n", root)
	fmt.Printf("外部敏感文件 = %s\n\n", secretFile)

	fmt.Println("== 正常请求 ==")
	try("normal.txt", root, "normal.txt")

	fmt.Println("\n== 攻击 A: 路径穿越 ==")
	try(`../../../etc/passwd`, root, "../../../etc/passwd")
	try(`sub/../../escape`, root, "sub/../../escape")
	try(`/etc/passwd (绝对路径)`, root, "/etc/passwd")

	if symlinkOK {
		fmt.Println("\n== 攻击 B: 符号链接（字符串上完全合法！）==")
		try("innocent.txt → 外部敏感文件", root, "innocent.txt")
	}

	fmt.Printf(`
结论:
  层1 (Clean + 前缀校验)  挡住 ../，但对符号链接【完全无效】—— 字符串上它就在 root 里
  层2 (EvalSymlinks 复查) 挡住符号链接，但检查完到真正 open 之间有 TOCTOU 窗口:
                          攻击者可以在这个窗口里把普通文件换成符号链接
  层3 (os.Root/openat2)   内核在【解析路径的每一步】都约束在 root 内，无窗口 ✅
                          Go 1.24+ 可用 (当前 Go %s)

Agent/Sandbox 的选择: 有 Go 1.24+ 就直接用 os.Root；否则层1+层2 并接受残余风险，
再叠加第 11 章的 mount namespace / chroot 做兜底。
`, runtime.Version())
}
