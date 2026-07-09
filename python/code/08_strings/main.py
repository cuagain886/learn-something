"""
═══════════════════════════════════════════════════════════════════

    08_strings —— 字符串与 Unicode

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. 字符串是不可变序列
 2. 常用字符串方法
 3. 编码与 Unicode：str vs bytes
 4. 正则表达式入门

【运行】python main.py

【与其他语言的对照】
  - Python 3 的 str 默认就是 Unicode（Go 的 string 是 UTF-8 字节序列）
  - Python 的 str 不可变（和 Go 一样），修改会创建新字符串
  - len(str) 返回的是字符数（Go 的 len 返回字节数）
  - Python 有丰富的字符串方法，不需要额外导入包
"""


def demo_basics():
    print("══════ 1. 字符串基础 ══════")

    # 单引号和双引号等价（惯例：内部有引号时交替使用，避免转义）
    s1 = 'Hello'
    s2 = "Hello"
    s3 = "He said 'hi'"
    s4 = 'He said "hi"'

    # 三引号：多行字符串
    multi = """第一行
第二行
第三行"""
    print(s1)
    print(s2)
    print(s3)
    print(s4)
    print(multi)

    # 原始字符串（raw string）：不转义 \
    path = r"C:\Users\admin\docs"   # 不需要写 C:\\Users\\...
    print(f"raw string: {path}")

    # 字节串（bytes）：b 前缀
    data = b"hello"                  # 只能包含 ASCII
    print(f"bytes: {data}, type: {type(data)}")

    # ── 字符串是序列 ──
    s = "Hello, 世界!"
    print(f"len(s) = {len(s)}")       # 9（字符数，不是字节数！）
    print(f"s[0] = {s[0]}")           # H
    print(f"s[-1] = {s[-1]}")         # !
    print(f"s[7:9] = {s[7:9]}")       # 界!
    print(f"s[::-1] = {s[::-1]}")     # !界世 ,olleH（反转）

    # ⚠️ 字符串不可变
    # s[0] = "h"  # TypeError!

    # 遍历字符串
    for ch in "Python":
        print(ch, end=" ")
    print()


def demo_methods():
    print("\n══════ 2. 常用字符串方法 ══════")

    s = "  Hello, World!  "

    # ── 大小写 ──
    print(f"upper: '{s.upper()}'")
    print(f"lower: '{s.lower()}'")
    print(f"title: '{'hello world'.title()}'")       # Hello World
    print(f"capitalize: '{'hello world'.capitalize()}'")  # Hello world
    print(f"swapcase: '{'Hello'.swapcase()}'")       # hELLO

    # ── 去除空白 ──
    print(f"strip:  '{s.strip()}'")     # 两端
    print(f"lstrip: '{s.lstrip()}'")    # 左端
    print(f"rstrip: '{s.rstrip()}'")    # 右端

    # ── 查找与替换 ──
    text = "Hello, World! Hello, Python!"
    print(f"find('World'): {text.find('World')}")      # 7（返回索引，没找到返回 -1）
    print(f"index('World'): {text.index('World')}")    # 7（没找到抛 ValueError）
    print(f"count('Hello'): {text.count('Hello')}")    # 2
    print(f"replace: {text.replace('Hello', 'Hi')}")   # 全部替换
    print(f"startswith: {text.startswith('Hello')}")    # True
    print(f"endswith: {text.endswith('!')}")            # True

    # ── 分割与连接 ──
    csv_line = "Alice,30,北京"
    parts = csv_line.split(",")        # 按分隔符分割
    print(f"split: {parts}")           # ['Alice', '30', '北京']

    joined = " | ".join(parts)         # 用分隔符连接
    print(f"join: {joined}")           # Alice | 30 | 北京

    # splitlines：按行分割
    multi = "line1\nline2\nline3"
    print(f"splitlines: {multi.splitlines()}")

    # ── 判断类型 ──
    print(f"'123'.isdigit(): {'123'.isdigit()}")       # True
    print(f"'abc'.isalpha(): {'abc'.isalpha()}")       # True
    print(f"'abc123'.isalnum(): {'abc123'.isalnum()}") # True
    print(f"'   '.isspace(): {'   '.isspace()}")       # True

    # ── 对齐与填充 ──
    
    print(f"ljust:  '{'Hi'.ljust(10, '-')}'")     # Hi--------
    print(f"rjust:  '{'Hi'.rjust(10, '-')}'")     # --------Hi
    print(f"center: '{'Hi'.center(10, '-')}'")    # ----Hi----
    print(f"zfill:  '{'42'.zfill(6)}'")           # 000042


def demo_string_building():
    print("\n══════ 3. 字符串拼接性能 ══════")

    # ⚠️ 循环中用 + 拼接字符串：每次创建新对象，O(n²)
    # 少量拼接没问题，大量拼接应该用 join 或 io.StringIO

    # 方式一：join（⭐推荐）
    parts = [str(i) for i in range(10)]
    result = ", ".join(parts)
    print(f"join: {result}")

    # 方式二：io.StringIO（类似 Go 的 strings.Builder）
    import io
    buf = io.StringIO()
    for i in range(5):
        buf.write(f"item{i} ")
    print(f"StringIO: {buf.getvalue()}")

    # 方式三：f-string（少量拼接最直观）
    name, age = "Alice", 30
    s = f"{name} is {age} years old"
    print(f"f-string: {s}")


def demo_encoding():
    print("\n══════ 4. 编码与 Unicode ══════")

    # Python 3 的 str 是 Unicode 字符串（内部可能是 UTF-8/16/32，取决于实现）
    # bytes 是字节序列

    # ── str -> bytes：encode ──
    text = "Hello, 世界!"
    utf8_bytes = text.encode("utf-8")
    gbk_bytes = text.encode("gbk")
    print(f"UTF-8 编码: {utf8_bytes}")     # 中文字符占 3 字节
    print(f"GBK 编码:   {gbk_bytes}")      # 中文字符占 2 字节
    print(f"UTF-8 长度: {len(utf8_bytes)}")  # 13
    print(f"str 长度:   {len(text)}")        # 9（字符数）

    # ── bytes -> str：decode ──
    decoded = utf8_bytes.decode("utf-8")
    print(f"解码: {decoded}")

    # ⚠️ 编码/解码不匹配会报错或乱码
    # gbk_bytes.decode("utf-8")  # UnicodeDecodeError!

    # ── ord() 和 chr()：字符与码点互转 ──
    print(f"ord('A') = {ord('A')}")        # 65
    print(f"ord('中') = {ord('中')}")       # 20013
    print(f"chr(65) = {chr(65)}")          # A
    print(f"chr(20013) = {chr(20013)}")    # 中

    # Unicode 转义
    print(f"\\u4e2d = {'\\u4e2d'}")          # 中
    print(f"emoji: \\U0001F600 = {chr(0x1F600)}")  # 😀


def demo_regex():
    print("\n══════ 5. 正则表达式 re ══════")
    import re

    text = "我的邮箱是 alice@example.com，电话 138-1234-5678"

    # ── 搜索 ──
    match = re.search(r"\w+@\w+\.\w+", text)
    if match:
        print(f"找到邮箱: {match.group()}")

    # ── 查找所有 ──
    numbers = re.findall(r"\d+", text)
    print(f"所有数字: {numbers}")

    # ── 替换 ──
    masked = re.sub(r"\d", "*", text)
    print(f"替换数字: {masked}")

    # ── 分割 ──
    parts = re.split(r"[,，;；]", "苹果,香蕉，橘子;葡萄")
    print(f"多分隔符分割: {parts}")

    # ── 编译正则（多次使用时提高性能） ──
    pattern = re.compile(r"(\d{3})-(\d{4})-(\d{4})")
    m = pattern.search(text)
    if m:
        print(f"电话: {m.group()}, 区号: {m.group(1)}")

    # ⚠️ 正则表达式总是用 r"..." 原始字符串，避免 \\ 转义混乱


if __name__ == "__main__":
    demo_basics()
    demo_methods()
    demo_string_building()
    demo_encoding()
    demo_regex()
