/*
═══════════════════════════════════════════════════════════════════

	19_stdlib —— 常用标准库速览：time / os 文件 / json / http

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. time：时间获取、格式化（Go 独特的参考时间！）、计算
 2. os + io：文件读写
 3. encoding/json：序列化与反序列化（结构体 tag 终于派上用场）
 4. net/http：几行代码写 HTTP 服务端 + 客户端

【运行】go run ./19_stdlib

	（本例的 HTTP 演示在本地起临时服务器自问自答，无需联网）

【Go 标准库的地位】

	"自带电池"是 Go 的卖点：HTTP 服务器、JSON、加密、模板、测试……
	开箱即用且生产可用 —— 很多公司的线上服务就裸用 net/http。
*/
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"time"
)

func main() {
	demoTime()
	demoFiles()
	demoJSON()
	demoHTTP()
}

// ───────────────────────────────────────────────────────────────
// 1. time 包
// ───────────────────────────────────────────────────────────────
func demoTime() {
	fmt.Println("══════ 1. time ══════")
	now := time.Now() // 当前本地时间，类型 time.Time
	fmt.Println("现在:", now.Format("2006-01-02 15:04:05"))

	// ★ Go 的奇葩设定：格式化不用 %Y-%m-%d，而是用一个【参考时间】当模板：
	//      2006-01-02 15:04:05 (Mon Jan 2 2006, MST)
	//   记忆口诀：01/02 03:04:05PM '06 —— 月日时分秒年 = 1 2 3 4 5 6
	fmt.Println("只要日期:", now.Format("2006-01-02"))
	fmt.Println("中式格式:", now.Format("2006年01月02日 15时04分"))

	// 解析：同一个参考时间反向使用
	t, err := time.Parse("2006-01-02", "2024-06-01")
	fmt.Println("解析结果:", t.Year(), t.Month(), t.Day(), err)

	// 时间运算：time.Duration（纳秒计数的 int64，带单位常量）
	meeting := now.Add(90 * time.Minute) // 加时长
	fmt.Println("90 分钟后:", meeting.Format("15:04"))
	diff := meeting.Sub(now) // 两时刻之差 => Duration
	fmt.Println("相差:", diff, "=", diff.Hours(), "小时")
	fmt.Println("是否在它之前:", now.Before(meeting)) // 比较：Before/After/Equal

	// 计时惯用法
	start := time.Now()
	time.Sleep(20 * time.Millisecond)     // 模拟一段工作
	fmt.Println("耗时:", time.Since(start)) // Since = Now().Sub(start)
}

// ───────────────────────────────────────────────────────────────
// 2. 文件读写（os 包）
// ───────────────────────────────────────────────────────────────
func demoFiles() {
	fmt.Println("\n══════ 2. 文件读写 ══════")
	// 在系统临时目录里演示，结束后清理，不污染你的磁盘
	path := filepath.Join(os.TempDir(), "go_learn_demo.txt")
	// filepath.Join 自动用对的路径分隔符（Windows \ 、Linux /）

	// ── 一次性写入：小文件最简单的方式 ──
	content := []byte("第一行\n第二行\n第三行\n")     // 文件 API 操作 []byte
	err := os.WriteFile(path, content, 0644) // 0644 是 Unix 权限位（Windows 下近似处理）
	if err != nil {                          // 文件操作永远要查 err！
		fmt.Println("写文件失败:", err)
		return
	}
	fmt.Println("已写入:", path)

	// ── 一次性读取 ──
	data, err := os.ReadFile(path)
	if err != nil {
		fmt.Println("读文件失败:", err)
		return
	}
	fmt.Printf("读出 %d 字节:\n%s", len(data), data)

	// ── 追加写入：用 OpenFile 指定打开模式 ──
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0644) // 追加|只写
	if err == nil {
		fmt.Fprintln(f, "追加的第四行") // Fprintln：往任何 io.Writer 写
		f.Close()                 // 这里就两行操作，直接 Close 也行
	}

	// ── 流式读取：大文件不能一口吞，用 Open + 缓冲读 ──
	f2, err := os.Open(path) // 只读打开，返回 *os.File（它是 io.Reader！）
	if err == nil {
		defer f2.Close()        // ★ 标准范式：打开成功立刻 defer Close
		buf := make([]byte, 16) // 每次最多读 16 字节
		total := 0
		for {
			n, err := f2.Read(buf) // 读到 buf 里，n 是实际读到的字节数
			total += n
			if err == io.EOF { // io.EOF 表示读完了——它是信号不是事故
				break
			}
		}
		fmt.Println("流式读取共", total, "字节")
		// 按行读取用 bufio.Scanner（处理日志等文本文件的标配）：
		//   sc := bufio.NewScanner(f2)
		//   for sc.Scan() { line := sc.Text(); ... }
	}

	os.Remove(path) // 删除演示文件
	fmt.Println("已清理临时文件")
}

// ───────────────────────────────────────────────────────────────
// 3. encoding/json —— 结构体 tag 实战
// ───────────────────────────────────────────────────────────────

// Movie 演示 JSON 映射规则的结构体。
// ⚠️ 只有【导出】字段（大写开头）才会被序列化 —— json 包靠反射读字段，
// 未导出字段它根本看不见。tag 控制 JSON 里的键名和行为：
type Movie struct {
	Title    string   `json:"title"` // JSON 键叫 title
	Year     int      `json:"year"`
	Rating   float64  `json:"rating,omitempty"` // 零值时整个字段省略
	Actors   []string `json:"actors"`           // 切片 -> JSON 数组
	Director string   `json:"-"`                // 永不序列化
	views    int      // 未导出：json 包看不见它
}

func demoJSON() {
	fmt.Println("\n══════ 3. JSON ══════")
	m := Movie{
		Title:    "流浪地球",
		Year:     2019,
		Actors:   []string{"吴京", "屈楚萧"},
		Director: "郭帆", // 会被 `json:"-"` 排除
		views:    1000, // 未导出，自动忽略
	}

	// ── 序列化：Go 值 -> JSON 字节 ──
	b, err := json.Marshal(m) // 返回 []byte
	fmt.Println("紧凑 JSON:", string(b), err)
	// 注意输出里：键名变成了 tag 指定的小写；Rating 是零值被 omitempty 省了；
	// Director 和 views 消失了

	// MarshalIndent：带缩进的漂亮格式（前缀 "", 缩进两个空格）
	pretty, _ := json.MarshalIndent(m, "", "  ")
	fmt.Printf("美化 JSON:\n%s\n", pretty)

	// ── 反序列化：JSON -> Go 值 ──
	raw := `{"title":"黑客帝国","year":1999,"rating":8.7,"actors":["基努"]}`
	var m2 Movie
	err = json.Unmarshal([]byte(raw), &m2) // ★ 必须传指针，否则填不进去
	fmt.Printf("解析结果: %+v (err=%v)\n", m2, err)

	// JSON 结构未知时，解析到 map[string]any 再断言（灵活但失去类型安全）
	var anyData map[string]any
	json.Unmarshal([]byte(raw), &anyData)
	fmt.Println("动态解析 year =", anyData["year"]) // ⚠️ JSON 数字默认变 float64！
}

// ───────────────────────────────────────────────────────────────
// 4. net/http —— 服务端 + 客户端
// ───────────────────────────────────────────────────────────────
func demoHTTP() {
	fmt.Println("\n══════ 4. HTTP ══════")

	// ── 服务端：注册路由 -> 写响应，就这么多 ──
	mux := http.NewServeMux() // 路由器
	// HandleFunc 注册处理函数：签名固定为 func(http.ResponseWriter, *http.Request)
	// "GET /hello" 是 Go 1.22+ 的"方法+路径"模式语法
	mux.HandleFunc("GET /hello", func(w http.ResponseWriter, r *http.Request) {
		name := r.URL.Query().Get("name") // 读 ?name=xxx 查询参数
		fmt.Fprintf(w, "你好, %s!", name)   // 往 ResponseWriter 写 = 返回响应体
	})
	mux.HandleFunc("GET /api/movie", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json") // 设置响应头
		// 直接把结构体编码进响应流 —— Web API 的核心三行
		json.NewEncoder(w).Encode(Movie{Title: "星际穿越", Year: 2014})
	})

	// 真实项目的启动方式（阻塞监听 8080 端口）：
	//     http.ListenAndServe(":8080", mux)
	// 教学演示用 httptest 起一个随机端口的临时服务器，自动选址、可关闭：
	server := httptest.NewServer(mux)
	defer server.Close()
	fmt.Println("临时服务器地址:", server.URL)

	// ── 客户端：http.Get 一行发请求 ──
	resp, err := http.Get(server.URL + "/hello?name=Gopher")
	if err != nil {
		fmt.Println("请求失败:", err)
		return
	}
	defer resp.Body.Close()          // ★ 必须关闭响应体，否则连接泄漏！
	body, _ := io.ReadAll(resp.Body) // 响应体是 io.Reader，读出全部
	fmt.Println("状态:", resp.Status, "响应:", string(body))

	// 请求 JSON 接口并直接解码到结构体
	resp2, err := http.Get(server.URL + "/api/movie")
	if err == nil {
		defer resp2.Body.Close()
		var mv Movie
		json.NewDecoder(resp2.Body).Decode(&mv) // 从流直接解码
		fmt.Printf("拿到电影: %+v\n", mv)
	}
	// 生产环境注意：默认 http.Get 没有超时！应自建 Client：
	//     client := &http.Client{Timeout: 10 * time.Second}
	// 并用 http.NewRequestWithContext 接入第 17 节的 context 体系
}
