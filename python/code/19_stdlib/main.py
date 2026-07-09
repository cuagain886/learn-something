"""
═══════════════════════════════════════════════════════════════════

    19_stdlib —— 常用标准库速览：datetime / pathlib / json / http

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. datetime：日期时间处理
 2. pathlib：现代文件路径操作（替代 os.path）
 3. json：序列化与反序列化
 4. http.server / urllib：HTTP 服务端与客户端
 5. 其他常用标准库一览

【运行】python main.py

【Python 标准库的地位】
  "batteries included"（自带电池）是 Python 的核心卖点：
  JSON、HTTP、正则、数据库、邮件、压缩、加密、单元测试……
  开箱即用，很多场景不需要任何第三方库。
"""
import datetime
import json
import os
import pathlib
import tempfile
from http.server import HTTPServer, BaseHTTPRequestHandler
import threading
import urllib.request


# ───────────────────────────────────────────────────────────────
# 1. datetime 日期时间
# ───────────────────────────────────────────────────────────────
def demo_datetime():
    print("══════ 1. datetime ══════")

    # 获取当前时间
    now = datetime.datetime.now()
    today = datetime.date.today()
    print(f"  现在: {now}")
    print(f"  今天: {today}")

    # 创建特定日期
    birthday = datetime.date(1991, 12, 25)
    print(f"  生日: {birthday}")

    # ── 格式化（strftime） ──
    print(f"  格式化: {now.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"  中文: {now.strftime('%Y年%m月%d日')}")
    # 常用格式码：
    # %Y 四位年  %m 月  %d 日  %H 时(24h)  %M 分  %S 秒
    # %A 星期名  %B 月份名  %I 时(12h)  %p AM/PM

    # ── 解析（strptime） ──
    parsed = datetime.datetime.strptime("2025-06-15 14:30:00", "%Y-%m-%d %H:%M:%S")
    print(f"  解析: {parsed}")

    # ── 时间计算（timedelta） ──
    delta = datetime.timedelta(days=7, hours=3)
    future = now + delta
    print(f"  7天3小时后: {future}")

    # 两个日期相减
    diff = datetime.date(2025, 12, 31) - today
    print(f"  距2025年底: {diff.days} 天")

    # ── 时间戳 ──
    timestamp = now.timestamp()
    from_ts = datetime.datetime.fromtimestamp(timestamp)
    print(f"  时间戳: {timestamp:.0f}")
    print(f"  从时间戳还原: {from_ts}")

    # ⚠️ 时区处理：推荐用 zoneinfo（Python 3.9+）
    from zoneinfo import ZoneInfo
    utc_now = datetime.datetime.now(ZoneInfo("UTC"))
    beijing = utc_now.astimezone(ZoneInfo("Asia/Shanghai"))
    print(f"  UTC: {utc_now.strftime('%H:%M')}")
    print(f"  北京: {beijing.strftime('%H:%M')}")


# ───────────────────────────────────────────────────────────────
# 2. pathlib（⭐推荐替代 os.path）
# ───────────────────────────────────────────────────────────────
def demo_pathlib():
    print("\n══════ 2. pathlib ══════")

    # 创建路径对象
    p = pathlib.Path(".")
    print(f"  当前目录: {p.resolve()}")

    # 路径拼接（用 / 运算符，非常优雅）
    config = pathlib.Path.home() / ".config" / "myapp" / "settings.json"
    print(f"  配置路径: {config}")

    # 路径属性
    example = pathlib.Path("/Users/alice/project/main.py")
    print(f"  name: {example.name}")           # main.py
    print(f"  stem: {example.stem}")           # main
    print(f"  suffix: {example.suffix}")       # .py
    print(f"  parent: {example.parent}")       # /Users/alice/project
    print(f"  parts: {example.parts}")         # ('/', 'Users', 'alice', ...)

    # 判断存在
    print(f"  当前目录存在: {pathlib.Path('.').exists()}")

    # 遍历目录
    print("  当前目录的 .py 文件:")
    for py_file in pathlib.Path(".").glob("*.py"):
        print(f"    {py_file}")

    # 递归遍历
    # for f in Path(".").rglob("*.py"):
    #     print(f)

    # 文件读写（pathlib 自带！）
    tmp = pathlib.Path(tempfile.mktemp(suffix=".txt"))
    tmp.write_text("Hello from pathlib!", encoding="utf-8")
    content = tmp.read_text(encoding="utf-8")
    print(f"  pathlib 读写: {content}")
    tmp.unlink()   # 删除文件


# ───────────────────────────────────────────────────────────────
# 3. json 序列化
# ───────────────────────────────────────────────────────────────
def demo_json():
    print("\n══════ 3. JSON ══════")

    # Python -> JSON
    data = {
        "name": "Alice",
        "age": 30,
        "hobbies": ["reading", "coding"],
        "address": {"city": "北京", "zip": "100000"},
    }

    # 序列化（Python 对象 -> JSON 字符串）
    json_str = json.dumps(data, ensure_ascii=False, indent=2)
    print(f"  dumps:\n{json_str}")
    # ensure_ascii=False：中文不转义
    # indent=2：美化输出

    # 反序列化（JSON 字符串 -> Python 对象）
    parsed = json.loads(json_str)
    print(f"  loads: {parsed['name']}, {parsed['address']['city']}")

    # 文件读写
    tmp = pathlib.Path(tempfile.mktemp(suffix=".json"))
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    with open(tmp, "r", encoding="utf-8") as f:
        from_file = json.load(f)
    print(f"  从文件读取: {from_file['name']}")
    tmp.unlink()

    # ⚠️ JSON 类型映射：
    # Python dict    <-> JSON object
    # Python list    <-> JSON array
    # Python str     <-> JSON string
    # Python int/float <-> JSON number
    # Python True/False <-> JSON true/false
    # Python None    <-> JSON null

    # 自定义序列化（处理 datetime 等非标准类型）
    class DateEncoder(json.JSONEncoder):
        def default(self, obj):
            if isinstance(obj, datetime.date):
                return obj.isoformat()
            return super().default(obj)

    event = {"name": "会议", "date": datetime.date.today()}
    print(f"  自定义编码: {json.dumps(event, cls=DateEncoder, ensure_ascii=False)}")


# ───────────────────────────────────────────────────────────────
# 4. HTTP 服务端 + 客户端
# ───────────────────────────────────────────────────────────────
def demo_http():
    print("\n══════ 4. HTTP ══════")

    # ── 简单的 HTTP 服务端 ──
    class MyHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            response = json.dumps({"message": "Hello from Python!", "path": self.path})
            self.wfile.write(response.encode())

        def log_message(self, format, *args):
            pass   # 静默日志

    server = HTTPServer(("127.0.0.1", 0), MyHandler)   # 0 = 随机端口
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever)
    thread.daemon = True
    thread.start()
    print(f"  服务器启动在 http://127.0.0.1:{port}")

    # ── HTTP 客户端（标准库 urllib） ──
    url = f"http://127.0.0.1:{port}/api/hello"
    with urllib.request.urlopen(url) as resp:
        data = json.loads(resp.read().decode())
        print(f"  响应: {data}")

    server.shutdown()
    print("  服务器已关闭")

    # ⚠️ 实际项目推荐用第三方库：
    # - 客户端：requests / httpx
    # - 服务端：Flask / FastAPI / Django


# ───────────────────────────────────────────────────────────────
# 5. 其他常用标准库速览
# ───────────────────────────────────────────────────────────────
def demo_other_stdlib():
    print("\n══════ 5. 其他常用标准库 ══════")

    info = """
    ┌──────────────────┬──────────────────────────────────┐
    │ 模块             │ 用途                             │
    ├──────────────────┼──────────────────────────────────┤
    │ os / sys         │ 系统交互、环境变量、命令行参数     │
    │ pathlib          │ ⭐ 现代文件路径（替代 os.path）   │
    │ json             │ JSON 序列化                      │
    │ re               │ 正则表达式                       │
    │ datetime         │ 日期时间                         │
    │ collections      │ 高级容器（Counter, deque, ...）  │
    │ itertools        │ 高效迭代工具                     │
    │ functools        │ 函数工具（lru_cache, partial..） │
    │ typing           │ 类型提示                         │
    │ dataclasses      │ 数据类                           │
    │ logging          │ 日志                             │
    │ unittest/pytest  │ 测试框架                         │
    │ argparse         │ 命令行参数解析                   │
    │ subprocess       │ 执行外部命令                     │
    │ threading        │ 多线程                           │
    │ multiprocessing  │ 多进程                           │
    │ asyncio          │ 异步 I/O                         │
    │ sqlite3          │ SQLite 数据库                    │
    │ hashlib          │ 哈希/摘要（MD5, SHA...）         │
    │ csv              │ CSV 文件读写                     │
    │ pickle           │ Python 对象序列化                │
    │ struct           │ 二进制数据打包/解包              │
    │ socket           │ 底层网络编程                     │
    │ http.server      │ 简单 HTTP 服务器                 │
    │ email            │ 邮件处理                         │
    │ zipfile/tarfile  │ 压缩文件                         │
    │ abc              │ 抽象基类                         │
    │ contextlib       │ 上下文管理器工具                 │
    │ textwrap         │ 文本换行与缩进                   │
    │ pprint           │ 美化打印复杂数据结构             │
    └──────────────────┴──────────────────────────────────┘
    """
    print(info)


if __name__ == "__main__":
    demo_datetime()
    demo_pathlib()
    demo_json()
    demo_http()
    demo_other_stdlib()
