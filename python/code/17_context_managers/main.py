"""
═══════════════════════════════════════════════════════════════════

    17_context_managers —— 上下文管理器与 with 语句

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. with 语句的作用：自动资源管理
 2. __enter__ / __exit__ 协议
 3. contextlib.contextmanager 装饰器
 4. 多上下文管理器与嵌套
 5. 异步上下文管理器（async with）

【运行】python main.py

【与其他语言的对照】
  - Go 的 defer 用于资源清理，但不限定作用域
  - Python 的 with 更结构化：进入时获取资源，退出时自动释放
  - Java 的 try-with-resources、C# 的 using 是类似概念
  - contextlib.contextmanager 让写上下文管理器像写生成器一样简单
"""
import contextlib
import os
import tempfile
import time


# ───────────────────────────────────────────────────────────────
# 1. with 语句基础
# ───────────────────────────────────────────────────────────────
def demo_basic():
    print("══════ 1. with 语句基础 ══════")

    # ⭐ 文件操作：with 自动关闭文件
    # 不用 with 的写法（容易忘记关闭或异常时不关闭）：
    # f = open("test.txt", "w")
    # f.write("hello")
    # f.close()

    # 用 with 的写法（推荐！）：
    tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False)
    tmp_path = tmp.name
    tmp.close()

    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write("Hello, World!")
        # 即使这里抛异常，文件也会被正确关闭

    with open(tmp_path, "r", encoding="utf-8") as f:
        content = f.read()
        print(f"  文件内容: {content}")

    os.unlink(tmp_path)   # 清理临时文件

    # with 的展开等价于：
    # f = open(...)         # __enter__
    # try:
    #     ...               # with 块中的代码
    # finally:
    #     f.close()         # __exit__


# ───────────────────────────────────────────────────────────────
# 2. 自定义上下文管理器（类方式）
# ───────────────────────────────────────────────────────────────
class Timer:
    """计时上下文管理器"""

    def __enter__(self):
        """进入 with 块时调用，返回值绑定到 as 后的变量"""
        self.start = time.perf_counter()
        return self   # 可以返回任意对象

    def __exit__(self, exc_type, exc_val, exc_tb):
        """退出 with 块时调用（即使有异常也会调用）

        参数：
          exc_type: 异常类型（没异常则为 None）
          exc_val:  异常值
          exc_tb:   异常 traceback

        返回值：
          True  -> 吞掉异常（不传播）
          False -> 让异常继续传播（默认）
        """
        self.elapsed = time.perf_counter() - self.start
        print(f"  耗时: {self.elapsed:.6f}s")
        return False   # 不吞掉异常


class SuppressError:
    """吞掉指定异常的上下文管理器"""

    def __init__(self, *exceptions):
        self.exceptions = exceptions

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if exc_type and issubclass(exc_type, self.exceptions):
            print(f"  吞掉异常: {exc_type.__name__}: {exc_val}")
            return True    # ⭐ 返回 True 表示异常已处理
        return False


def demo_class_cm():
    print("\n══════ 2. 自定义上下文管理器 ══════")

    with Timer() as t:
        total = sum(range(1_000_000))
    print(f"  结果: {total}")

    # 异常处理
    with SuppressError(ValueError, TypeError):
        int("not_a_number")   # ValueError 被吞掉
    print("  继续执行（异常已被吞掉）")


# ───────────────────────────────────────────────────────────────
# 3. contextlib.contextmanager（⭐推荐方式）
# ───────────────────────────────────────────────────────────────
@contextlib.contextmanager
def working_directory(path):
    """临时切换工作目录的上下文管理器"""
    old_dir = os.getcwd()
    try:
        os.chdir(path)
        yield path        # yield 之前 = __enter__，之后 = __exit__
    finally:
        os.chdir(old_dir)  # 无论如何都恢复


@contextlib.contextmanager
def timer_cm(label=""):
    """用 contextmanager 装饰器实现的计时器（比写类简洁得多）"""
    start = time.perf_counter()
    try:
        yield
    finally:
        elapsed = time.perf_counter() - start
        print(f"  [{label}] 耗时: {elapsed:.6f}s")


@contextlib.contextmanager
def database_transaction():
    """模拟数据库事务"""
    print("  BEGIN TRANSACTION")
    try:
        yield
        print("  COMMIT")
    except Exception as e:
        print(f"  ROLLBACK (因为 {e})")
        raise


def demo_contextlib():
    print("\n══════ 3. contextlib.contextmanager ══════")

    with timer_cm("求和"):
        total = sum(range(1_000_000))

    # 模拟事务
    try:
        with database_transaction():
            print("  执行 SQL: INSERT ...")
            # raise RuntimeError("模拟错误")  # 取消注释看 ROLLBACK
            print("  执行 SQL: UPDATE ...")
    except RuntimeError:
        pass


# ───────────────────────────────────────────────────────────────
# 4. 多上下文管理器
# ───────────────────────────────────────────────────────────────
def demo_multiple():
    print("\n══════ 4. 多上下文管理器 ══════")

    # 方式一：同一行多个（Python 3.1+）
    tmp1 = tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False)
    tmp2 = tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False)
    tmp1.close()
    tmp2.close()

    with open(tmp1.name, "w") as f1, open(tmp2.name, "w") as f2:
        f1.write("file1")
        f2.write("file2")

    os.unlink(tmp1.name)
    os.unlink(tmp2.name)

    # 方式二：括号分组（Python 3.10+，推荐多个时使用）
    # with (
    #     open("file1.txt") as f1,
    #     open("file2.txt") as f2,
    #     Timer() as t,
    # ):
    #     ...

    # contextlib.ExitStack：动态管理多个上下文
    print("  ExitStack 演示:")
    with contextlib.ExitStack() as stack:
        # 可以动态添加上下文管理器
        stack.callback(lambda: print("    清理任务 1"))
        stack.callback(lambda: print("    清理任务 2"))
        print("    执行主逻辑")
    # 退出时按 LIFO 顺序清理


# ───────────────────────────────────────────────────────────────
# 5. 常用 contextlib 工具
# ───────────────────────────────────────────────────────────────
def demo_contextlib_tools():
    print("\n══════ 5. contextlib 工具箱 ══════")

    # suppress：吞掉指定异常（替代 try/except/pass）
    with contextlib.suppress(FileNotFoundError):
        os.remove("不存在的文件.txt")
    print("  suppress: 文件不存在也不报错")

    # redirect_stdout：重定向标准输出
    import io
    f = io.StringIO()
    with contextlib.redirect_stdout(f):
        print("这段输出被捕获了")
    print(f"  captured: {f.getvalue().strip()}")

    # closing：为没有实现 __exit__ 的对象添加 close() 调用
    # with contextlib.closing(some_resource) as r:
    #     r.do_something()
    # # 自动调用 r.close()


if __name__ == "__main__":
    demo_basic()
    demo_class_cm()
    demo_contextlib()
    demo_multiple()
    demo_contextlib_tools()
