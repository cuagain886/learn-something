/*
═══════════════════════════════════════════════════════════════════

	08_strings_runes —— 字符串、字节与 Unicode

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. string 的本质：不可变的字节序列（UTF-8 编码）
 2. byte vs rune：处理中文必须懂的区别
 3. strings 包常用函数（查找/替换/分割/拼接）
 4. strconv 包：字符串和数字互转
 5. 高效拼接：strings.Builder

【运行】go run ./08_strings_runes

【核心认知】

	Go 的 string 是【只读的 byte 数组】，源码文件是 UTF-8，
	所以一个中文字符占 3 个字节。len() 数的是【字节】不是字符！
*/
package main

import (
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"
)

func main() {
	fmt.Println("══════ 1. 字符串的本质：字节序列 ══════")
	s := "Go语言"
	// ⚠️ len() 返回的是【字节数】："Go" 2 字节 + 两个汉字各 3 字节 = 8
	fmt.Println("len(\"Go语言\") =", len(s)) // 8，不是 4！

	// 真正的"字符数"要用 utf8.RuneCountInString
	fmt.Println("字符数 =", utf8.RuneCountInString(s)) // 4

	// 按下标访问得到的是【字节】(byte)，不是字符
	fmt.Printf("s[0] = %c (%d)\n", s[0], s[0]) // G (71)
	fmt.Printf("s[2] = %d —— 这是'语'的第一个字节，单独无意义\n", s[2])

	// 字符串不可变：s[0] = 'g' 是编译错误。修改须先转成 []byte 或 []rune
	bs := []byte(s)                  // string -> 字节切片（拷贝一份，可修改）
	bs[0] = 'g'                      // 修改副本
	fmt.Println("改完转回:", string(bs)) // go语言；string(bs) 字节切片 -> 字符串

	fmt.Println("\n══════ 2. byte vs rune ══════")
	// byte = uint8 —— 一个字节，适合处理 ASCII / 二进制数据
	// rune = int32 —— 一个 Unicode 码点（"字符"），适合处理多语言文本
	rs := []rune(s)                              // string -> rune 切片：按【字符】切开
	fmt.Println("rune 切片长度 =", len(rs))          // 4
	fmt.Printf("第 3 个字符 = %c\n", rs[2])          // 语 ——按字符索引就对了
	fmt.Println("反转字符串:", reverseString("Go语言")) // 言语oG

	// ★ for range 遍历字符串时自动按【rune】解码（这是 range 的特殊优待）
	for i, r := range "Go语" {
		// i 是该字符的【起始字节下标】（注意 2 之后直接跳到 5 的话说明占3字节）
		fmt.Printf("  字节下标 %d: 字符 %c (码点 U+%04X)\n", i, r, r)
	}

	fmt.Println("\n══════ 3. strings 包：字符串操作工具箱 ══════")
	text := "Hello, Go! Go is great!"

	// ── 查找类 ──
	fmt.Println("包含 Go?      ", strings.Contains(text, "Go"))      // true
	fmt.Println("前缀 Hello?   ", strings.HasPrefix(text, "Hello"))  // true
	fmt.Println("后缀 great!?  ", strings.HasSuffix(text, "great!")) // true
	fmt.Println("Go 首次出现于 ", strings.Index(text, "Go"))            // 7（字节下标，找不到返回 -1）
	fmt.Println("Go 出现次数   ", strings.Count(text, "Go"))           // 2

	// ── 变换类 ──
	fmt.Println("全大写:", strings.ToUpper("hello"))                  // HELLO
	fmt.Println("全小写:", strings.ToLower("HELLO"))                  // hello
	fmt.Println("替换:  ", strings.ReplaceAll(text, "Go", "Golang")) // 全部替换
	fmt.Println("替换1次:", strings.Replace(text, "Go", "Golang", 1)) // 只换前 1 处
	fmt.Println("去空白:", strings.TrimSpace("  两边的空白被去掉  \n"))       // 去首尾空白
	fmt.Println("去指定:", strings.Trim("###标题###", "#"))             // 去首尾指定字符
	fmt.Println("重复:  ", strings.Repeat("-=", 10))                 // 重复拼接

	// ── 分割与拼接 ──
	csv := "苹果,香蕉,橙子"
	parts := strings.Split(csv, ",")                              // 按分隔符切成 []string
	fmt.Printf("分割: %q\n", parts)                                 // ["苹果" "香蕉" "橙子"]
	fmt.Println("拼接:", strings.Join(parts, " | "))                // 用分隔符合并回字符串
	fmt.Printf("按空白分词: %q\n", strings.Fields("  go   is\tfun\n")) // 智能按空白切

	fmt.Println("\n══════ 4. strconv：字符串 <-> 数字 ══════")
	// ⚠️ 不能用 int("123") 或 string(123) 互转！
	//   string(65) 得到 "A"（按码点转字符）—— vet 工具都会警告这种写法

	// 字符串 -> 数字：可能失败，所以返回 (值, error)
	n, err := strconv.Atoi("123") // Ascii to int
	fmt.Println("Atoi:", n, err)  // 123 <nil>
	_, err = strconv.Atoi("12a")  // 非法输入
	fmt.Println("非法输入的错误:", err)

	f, _ := strconv.ParseFloat("3.14", 64)   // 字符串 -> float64
	b, _ := strconv.ParseBool("true")        // "true"/"1"/"T" -> bool
	hex, _ := strconv.ParseInt("ff", 16, 64) // 按 16 进制解析
	fmt.Println("ParseFloat:", f, " ParseBool:", b, " 16进制ff =", hex)

	// 数字 -> 字符串
	fmt.Println("Itoa:", strconv.Itoa(456))                          // int -> "456"
	fmt.Println("Format:", strconv.FormatFloat(3.14159, 'f', 2, 64)) // "3.14"
	// 偷懒万能法：fmt.Sprintf("%d", 456) / Sprintf("%v", 任何值)

	fmt.Println("\n══════ 5. 高效拼接：strings.Builder ══════")
	// ⚠️ 陷阱：循环里用 += 拼接字符串，每次都分配新串拷贝旧内容，O(n²)！
	// 正确做法：strings.Builder 内部维护可增长缓冲区，O(n)
	var sb strings.Builder
	for i := 1; i <= 5; i++ {
		sb.WriteString("第")             // 追加字符串
		sb.WriteString(strconv.Itoa(i)) // 追加数字转的字符串
		sb.WriteString("项 ")
	}
	fmt.Println(sb.String()) // 最后一次性取出结果

	// 简单几段的拼接，直接 + 或 fmt.Sprintf 即可，不必教条
	full := "Hello" + ", " + "World"
	fmt.Println(full)

	fmt.Println("\n══════ 6. 多行字符串与转义 ══════")
	// 反引号原始字符串：写 JSON、SQL、正则不用满屏反斜杠
	queryJSON := `{
  "name": "gopher",
  "path": "C:\Users\go"
}` // 注意 \U 没有被转义，原样保留
	fmt.Println(queryJSON)
}

// reverseString 按字符（rune）反转字符串
// 若按字节反转，多字节的汉字会被拆碎成乱码 —— 这是 rune 存在的意义
func reverseString(s string) string {
	rs := []rune(s)                                    // 先按字符切开
	for i, j := 0, len(rs)-1; i < j; i, j = i+1, j-1 { // 双指针对调
		rs[i], rs[j] = rs[j], rs[i] // ★ Go 的多重赋值让交换无需临时变量
	}
	return string(rs) // rune 切片转回字符串
}
