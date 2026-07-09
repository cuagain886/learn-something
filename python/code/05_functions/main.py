"""
═══════════════════════════════════════════════════════════════════

    05_functions —— 函数：默认参数、*args、**kwargs、闭包

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. 函数定义、参数传递、返回值
 2. 默认参数、关键字参数、*args、**kwargs
 3. 函数是一等公民：函数对象、lambda、高阶函数
 4. 闭包（closure）与作用域规则 LEGB

【运行】python main.py

【与其他语言的核心差异】
  - Python 有默认参数、关键字参数、可变参数 —— 比 Go 灵活得多
  - ⚠️ 默认参数是可变对象时有经典陷阱（面试必考）
  - 所有参数传递都是"传对象引用"（pass by object reference）
  - lambda 只能写单个表达式，不能包含语句
  - 支持嵌套函数、闭包、装饰器（后面章节详讲）
"""


# ───────────────────────────────────────────────────────────────
# 1. 基本函数定义
# ───────────────────────────────────────────────────────────────
def demo_basic():
    print("══════ 1. 基本函数 ══════")

    def greet(name):
        """向某人打招呼（这是文档字符串 docstring）"""
        return f"你好，{name}！"

    print(greet("Python"))

    # 无返回值的函数实际返回 None
    def say_hello():
        print("  Hello!")
        # 没有 return 语句，或 return 后没有值

    result = say_hello()
    print(f"  返回值: {result}")  # None

    # 多返回值：实际是返回元组
    def divide(a, b):
        return a // b, a % b    # 返回 (商, 余数)

    q, r = divide(17, 5)       # 元组解包
    print(f"  17 ÷ 5 = {q} 余 {r}")


# ───────────────────────────────────────────────────────────────
# 2. 参数的各种形式
# ───────────────────────────────────────────────────────────────
def demo_parameters():
    print("\n══════ 2. 参数形式 ══════")

    # ── 默认参数 ──
    def connect(host, port=3306, timeout=30):
        print(f"  连接 {host}:{port}，超时 {timeout}s")

    connect("localhost")              # 使用全部默认值
    connect("localhost", 5432)        # 覆盖 port
    connect("localhost", timeout=10)  # 跳过 port，只覆盖 timeout（关键字参数）

    # ⚠️⚠️⚠️ 经典陷阱：默认参数是可变对象 ⚠️⚠️⚠️
    # 默认值在函数【定义时】只求值一次，后续调用共享同一个对象！
    def bad_append(item, lst=[]):     # ⚠️ 列表默认值是同一个对象！
        lst.append(item)
        return lst

    print(f"  bad_append(1) = {bad_append(1)}")  # [1]
    print(f"  bad_append(2) = {bad_append(2)}")  # [1, 2]  ⚠️ 不是 [2]！

    # 正确写法：用 None 做哨兵
    def good_append(item, lst=None):
        if lst is None:
            lst = []
        lst.append(item)
        return lst

    print(f"  good_append(1) = {good_append(1)}")  # [1]
    print(f"  good_append(2) = {good_append(2)}")  # [2] ✓

    # ── *args：收集位置参数为元组 ──
    def total(*args):
        print(f"  args 类型: {type(args)}, 值: {args}")
        return sum(args)

    print(f"  total(1,2,3) = {total(1, 2, 3)}")

    # ── **kwargs：收集关键字参数为字典 ──
    def show_info(**kwargs):
        print(f"  kwargs 类型: {type(kwargs)}")
        for key, value in kwargs.items():
            print(f"    {key} = {value}")

    show_info(name="Alice", age=30, city="北京")

    # ── 组合使用（参数顺序有规则） ──
    # def func(positional, /, normal, *, keyword_only, **kwargs):
    #   positional: 仅限位置参数（/之前）
    #   normal: 普通参数
    #   keyword_only: 仅限关键字参数（*之后）
    def demo_all(a, b, *args, sep=", ", **kwargs):
        print(f"  a={a}, b={b}, args={args}, sep='{sep}', kwargs={kwargs}")

    demo_all(1, 2, 3, 4, sep=" | ", x=10)

    # ── 仅限位置参数 / （Python 3.8+） ──
    def func_pos_only(a, b, /, c):
        print(f"  a={a}, b={b}, c={c}")

    func_pos_only(1, 2, c=3)   # ✓
    # func_pos_only(a=1, b=2, c=3)  # ⚠️ TypeError: a, b 不接受关键字

    # ── 仅限关键字参数 * ──
    def func_kw_only(a, *, b, c):
        print(f"  a={a}, b={b}, c={c}")

    func_kw_only(1, b=2, c=3)  # ✓
    # func_kw_only(1, 2, 3)    # ⚠️ TypeError: b, c 必须用关键字


# ───────────────────────────────────────────────────────────────
# 3. 参数传递本质："传对象引用"
# ───────────────────────────────────────────────────────────────
def demo_pass_by():
    print("\n══════ 3. 参数传递 ══════")

    # Python 参数传递既不是"传值"也不是"传引用"，而是"传对象引用"
    # （pass by object reference / pass by assignment）

    # 不可变对象：函数内"修改"实际是重新绑定，不影响外部
    def try_modify_int(x):
        x = 999   # 重新绑定了局部名字 x，不影响外部
        print(f"  函数内 x = {x}")

    n = 42
    try_modify_int(n)
    print(f"  函数外 n = {n}")   # 42 不变

    # 可变对象：如果函数内修改了对象（原地操作），外部能看到
    def try_modify_list(lst):
        lst.append(999)   # 修改了列表对象本身
        print(f"  函数内 lst = {lst}")

    my_list = [1, 2, 3]
    try_modify_list(my_list)
    print(f"  函数外 my_list = {my_list}")  # [1, 2, 3, 999] ⚠️ 被修改了！


# ───────────────────────────────────────────────────────────────
# 4. 函数是一等公民
# ───────────────────────────────────────────────────────────────
def demo_first_class():
    print("\n══════ 4. 函数是一等公民 ══════")

    # 函数可以赋值给变量
    def square(x):
        return x ** 2

    f = square           # f 现在也指向 square 函数对象
    print(f"  f(5) = {f(5)}")  # 25

    # 函数可以作为参数传递（高阶函数）
    def apply(func, value):
        return func(value)

    print(f"  apply(square, 7) = {apply(square, 7)}")

    # ── lambda 匿名函数 ──
    # 语法：lambda 参数: 表达式（只能是单个表达式，不能有语句）
    double = lambda x: x * 2
    print(f"  lambda double(5) = {double(5)}")

    # lambda 常用于 sorted/map/filter 的 key 参数
    pairs = [(1, "b"), (3, "a"), (2, "c")]
    pairs.sort(key=lambda p: p[1])    # 按第二个元素排序
    print(f"  按字母排序: {pairs}")

    # ── map / filter / reduce ──
    nums = [1, 2, 3, 4, 5]
    squares = list(map(lambda x: x ** 2, nums))
    evens = list(filter(lambda x: x % 2 == 0, nums))
    print(f"  map 平方: {squares}")     # [1, 4, 9, 16, 25]
    print(f"  filter 偶数: {evens}")    # [2, 4]

    # ⚠️ Pythonic 的替代：用列表推导式（下一节讲），通常比 map/filter 更易读
    #    squares = [x**2 for x in nums]
    #    evens = [x for x in nums if x % 2 == 0]


# ───────────────────────────────────────────────────────────────
# 5. 闭包与作用域 LEGB
# ───────────────────────────────────────────────────────────────
def demo_closure():
    print("\n══════ 5. 闭包与作用域 ══════")

    # LEGB 规则：变量查找顺序
    # L - Local（局部）
    # E - Enclosing（闭包外层函数）
    # G - Global（模块全局）
    # B - Built-in（内置）

    x = "global"

    def outer():
        x = "enclosing"

        def inner():
            # x = "local"    # 如果有这行，就用 local
            print(f"  inner 看到 x = {x}")   # enclosing

        inner()

    outer()

    # ── 闭包：内层函数捕获外层变量 ──
    def make_counter():
        count = 0

        def counter():
            nonlocal count   # ⚠️ 必须声明 nonlocal 才能修改闭包变量！
            count += 1
            return count

        return counter

    c = make_counter()
    print(f"  counter: {c()}, {c()}, {c()}")  # 1, 2, 3

    # ⚠️ 经典闭包陷阱：循环变量捕获
    funcs = []
    for i in range(3):
        funcs.append(lambda: i)   # ⚠️ 所有 lambda 捕获的是同一个变量 i！

    print(f"  闭包陷阱: {[f() for f in funcs]}")  # [2, 2, 2] 不是 [0, 1, 2]！

    # 修复方法：用默认参数捕获当前值
    funcs_fixed = []
    for i in range(3):
        funcs_fixed.append(lambda i=i: i)   # 默认参数在定义时求值

    print(f"  修复后:   {[f() for f in funcs_fixed]}")  # [0, 1, 2] ✓

    # ── global 和 nonlocal 关键字 ──
    # global：在函数内修改全局变量（少用，通常是代码异味）
    # nonlocal：在嵌套函数内修改外层函数的变量


if __name__ == "__main__":
    demo_basic()
    demo_parameters()
    demo_pass_by()
    demo_first_class()
    demo_closure()
