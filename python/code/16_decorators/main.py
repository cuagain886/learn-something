"""
═══════════════════════════════════════════════════════════════════

    16_decorators —— 装饰器

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. 装饰器的本质：函数包装函数
 2. 无参装饰器与带参装饰器
 3. functools.wraps 保留原函数信息
 4. 类装饰器
 5. 常用内置装饰器：property、classmethod、staticmethod、lru_cache

【运行】python main.py

【与其他语言的对照】
  - 装饰器 ≈ Go 的中间件模式（HTTP handler 包装）
  - Java 有注解（@Override），但不是装饰器（注解是元数据，不修改行为）
  - TypeScript/Python 的装饰器直接修改/增强函数/类的行为
  - 装饰器是 Python 元编程的核心工具之一
"""
import functools
import time


# ───────────────────────────────────────────────────────────────
# 1. 装饰器的本质
# ───────────────────────────────────────────────────────────────
def demo_basic():
    print("══════ 1. 装饰器的本质 ══════")

    # 装饰器就是"接受一个函数，返回一个新函数"的高阶函数

    def my_decorator(func):
        def wrapper(*args, **kwargs):
            print(f"  [before] 调用 {func.__name__}")
            result = func(*args, **kwargs)
            print(f"  [after] {func.__name__} 返回 {result}")
            return result
        return wrapper

    # 不用 @ 语法的写法：
    def add(a, b):
        return a + b

    add = my_decorator(add)   # 手动装饰
    add(3, 4)

    # 用 @ 语法（语法糖，等价于上面的手动装饰）：
    @my_decorator
    def multiply(a, b):
        return a * b

    multiply(3, 4)


# ───────────────────────────────────────────────────────────────
# 2. functools.wraps：保留原函数信息
# ───────────────────────────────────────────────────────────────
def timer(func):
    """计时装饰器：⭐ 注意 @functools.wraps"""
    @functools.wraps(func)   # ⚠️ 没有这行，函数名/文档字符串会丢失！
    def wrapper(*args, **kwargs):
        start = time.perf_counter()
        result = func(*args, **kwargs)
        elapsed = time.perf_counter() - start
        print(f"  {func.__name__} 耗时 {elapsed:.6f}s")
        return result
    return wrapper


def demo_wraps():
    print("\n══════ 2. functools.wraps ══════")

    @timer
    def slow_function():
        """这是一个慢函数"""
        time.sleep(0.01)
        return 42

    slow_function()
    print(f"  函数名: {slow_function.__name__}")     # slow_function（不是 wrapper）
    print(f"  文档: {slow_function.__doc__}")         # 这是一个慢函数


# ───────────────────────────────────────────────────────────────
# 3. 带参数的装饰器
# ───────────────────────────────────────────────────────────────
def retry(max_attempts=3, delay=0.1):
    """带参数的装饰器：需要三层嵌套"""
    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            last_exception = None
            for attempt in range(1, max_attempts + 1):
                try:
                    return func(*args, **kwargs)
                except Exception as e:
                    last_exception = e
                    print(f"  第 {attempt} 次尝试失败: {e}")
                    if attempt < max_attempts:
                        time.sleep(delay)
            raise last_exception
        return wrapper
    return decorator


def demo_parameterized():
    print("\n══════ 3. 带参数的装饰器 ══════")

    call_count = 0

    @retry(max_attempts=3, delay=0.01)
    def unstable_operation():
        nonlocal call_count
        call_count += 1
        if call_count < 3:
            raise ConnectionError("连接失败")
        return "成功！"

    result = unstable_operation()
    print(f"  结果: {result}")


# ───────────────────────────────────────────────────────────────
# 4. 多个装饰器叠加
# ───────────────────────────────────────────────────────────────
def bold(func):
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        return f"<b>{func(*args, **kwargs)}</b>"
    return wrapper

def italic(func):
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        return f"<i>{func(*args, **kwargs)}</i>"
    return wrapper


def demo_stacking():
    print("\n══════ 4. 装饰器叠加 ══════")

    @bold
    @italic
    def greet(name):
        return f"Hello, {name}"

    # 等价于: greet = bold(italic(greet))
    # 执行顺序：从内到外装饰，从外到内执行
    print(f"  {greet('Python')}")   # <b><i>Hello, Python</i></b>


# ───────────────────────────────────────────────────────────────
# 5. 类装饰器
# ───────────────────────────────────────────────────────────────
class CallCounter:
    """用类实现装饰器（通过 __call__）"""

    def __init__(self, func):
        functools.update_wrapper(self, func)
        self.func = func
        self.count = 0

    def __call__(self, *args, **kwargs):
        self.count += 1
        print(f"  {self.func.__name__} 被调用了 {self.count} 次")
        return self.func(*args, **kwargs)


def demo_class_decorator():
    print("\n══════ 5. 类装饰器 ══════")

    @CallCounter
    def say_hello():
        return "Hello!"

    say_hello()
    say_hello()
    say_hello()
    print(f"  总调用次数: {say_hello.count}")


# ───────────────────────────────────────────────────────────────
# 6. 装饰类的装饰器
# ───────────────────────────────────────────────────────────────
def singleton(cls):
    """单例装饰器：装饰类"""
    instances = {}

    @functools.wraps(cls)
    def get_instance(*args, **kwargs):
        if cls not in instances:
            instances[cls] = cls(*args, **kwargs)
        return instances[cls]

    return get_instance


def demo_class_decoration():
    print("\n══════ 6. 装饰类 ══════")

    @singleton
    class Database:
        def __init__(self):
            print("  Database 初始化（只应执行一次）")
            self.connected = True

    db1 = Database()
    db2 = Database()
    print(f"  db1 is db2: {db1 is db2}")  # True


# ───────────────────────────────────────────────────────────────
# 7. 常用内置/标准库装饰器
# ───────────────────────────────────────────────────────────────
def demo_builtin_decorators():
    print("\n══════ 7. 常用内置装饰器 ══════")

    # @property —— 第 10 节已讲

    # @staticmethod、@classmethod —— 第 10 节已讲

    # ⭐ @functools.lru_cache：自动缓存函数结果
    @functools.lru_cache(maxsize=128)
    def fibonacci(n):
        if n < 2:
            return n
        return fibonacci(n - 1) + fibonacci(n - 2)

    print(f"fib(100) = {fibonacci(100)}")     # 瞬间完成，没有缓存会爆栈
    print(f"缓存信息: {fibonacci.cache_info()}")

    # @functools.cache（Python 3.9+）：不限大小的缓存
    # 等价于 @functools.lru_cache(maxsize=None)

    # @functools.total_ordering —— 第 12 节已讲

    # @dataclasses.dataclass —— 第 10 节已讲

    # @contextlib.contextmanager —— 第 17 节讲


if __name__ == "__main__":
    demo_basic()
    demo_wraps()
    demo_parameterized()
    demo_stacking()
    demo_class_decorator()
    demo_class_decoration()
    demo_builtin_decorators()
