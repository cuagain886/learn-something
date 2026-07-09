"""
═══════════════════════════════════════════════════════════════════

    02_variables —— 变量、类型与动态特性

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. Python 的变量模型：名字（name）绑定到对象（object）
 2. 基本类型：int、float、bool、str、None
 3. 可变与不可变类型（Python 的核心概念！）
 4. 类型检查与类型转换
 5. 一切皆对象（everything is an object）

【运行】python main.py

【与其他语言的核心差异】
  - 动态类型：变量没有类型，对象才有类型。同一个名字可以先绑定 int 再绑定 str
  - 无需声明：直接赋值就创建变量，不存在 var / let / const 关键字
  - 整数无溢出：Python 的 int 是任意精度（大整数自动扩展），不会溢出！
  - 没有"未初始化"的变量：名字要么已绑定对象，要么 NameError
"""

# ───────────────────────────────────────────────────────────────
# 1. 变量赋值：名字绑定到对象
# ───────────────────────────────────────────────────────────────
def demo_variables():
    print("══════ 1. 变量赋值 ══════")

    # 直接赋值创建变量，不需要声明类型
    age = 30
    city = "北京"
    pi = 3.14159
    print(f"age = {age}, city = {city}, pi = {pi}")

    # 多重赋值（Python 特色语法）
    x, y = 10, 20         # 同时给多个变量赋值
    print(f"x = {x}, y = {y}")

    # 交换变量值：Python 不需要临时变量！
    x, y = y, x            # 底层是元组打包/解包
    print(f"交换后 x = {x}, y = {y}")

    # 链式赋值
    a = b = c = 0           # 三个名字都绑定到同一个对象 0
    print(f"a = {a}, b = {b}, c = {c}")

    # 解包赋值（unpack）
    first, *rest = [1, 2, 3, 4, 5]   # * 接收剩余元素
    print(f"first = {first}, rest = {rest}")  # first=1, rest=[2,3,4,5]

    # 增量赋值
    x += 10   # 等价于 x = x + 10
    print(f"x += 10 -> {x}")
    # ⚠️ Python 没有 ++ 和 -- 运算符！x++ 是语法错误


# ───────────────────────────────────────────────────────────────
# 2. Python 的变量本质：名字→对象的引用
# ───────────────────────────────────────────────────────────────
def demo_name_binding():
    print("\n══════ 2. 名字绑定模型 ══════")

    # Python 变量是"标签贴在对象上"，不是"盒子装数据"
    a = [1, 2, 3]
    b = a              # b 和 a 指向【同一个列表对象】
    b.append(4)        # 通过 b 修改，a 也能看到！
    print(f"a = {a}")  # [1, 2, 3, 4]   ⚠️ 新手常见陷阱

    # id() 查看对象的内存地址（身份标识）
    print(f"id(a) = {id(a)}, id(b) = {id(b)}")  # 相同！
    print(f"a is b = {a is b}")  # True：is 比较的是身份（是否同一个对象）

    # 重新赋值 ≠ 修改对象：赋值只是改变名字的绑定
    a = [10, 20]       # a 重新绑定到新列表，不影响 b
    print(f"重新赋值后 a = {a}, b = {b}")


# ───────────────────────────────────────────────────────────────
# 3. 基本类型一览
# ───────────────────────────────────────────────────────────────
def demo_basic_types():
    print("\n══════ 3. 基本类型 ══════")

    # ── int 整数 ──
    # Python 的 int 是任意精度！不存在 int8/int64 之分，永远不会溢出
    big = 10 ** 100        # 10 的 100 次方，轻松存储
    print(f"10^100 = {big}")
    print(f"type = {type(big)}")   # <class 'int'>

    # 数字字面量：支持下划线分隔、各种进制
    million = 1_000_000    # 下划线增强可读性
    hex_val = 0xFF         # 十六进制
    bin_val = 0b1010       # 二进制
    oct_val = 0o77         # 八进制
    print(f"million={million}, hex=0xFF={hex_val}, bin=0b1010={bin_val}, oct=0o77={oct_val}")

    # ── float 浮点数 ──
    # 只有 float（64 位双精度），没有 float32
    pi = 3.14159
    sci = 1.5e10           # 科学记数法
    inf = float("inf")     # 正无穷
    nan = float("nan")     # Not a Number
    print(f"pi={pi}, sci={sci}, inf={inf}, nan={nan}")

    # ⚠️ 浮点精度陷阱（和所有语言一样）
    print(f"0.1 + 0.2 == 0.3 ? {0.1 + 0.2 == 0.3}")  # False
    print(f"0.1 + 0.2 = {0.1 + 0.2}")                  # 0.30000000000000004
    # 需要精确计算用 decimal.Decimal

    # ── bool 布尔 ──
    # True 和 False（首字母大写！不是 true/false）
    # bool 是 int 的子类：True == 1, False == 0
    print(f"True + True = {True + True}")      # 2
    print(f"True == 1 ? {True == 1}")           # True
    print(f"isinstance(True, int) = {isinstance(True, int)}")  # True

    # ── 真值测试（truthy / falsy）──
    # 以下值视为 False（falsy）：
    #   None, False, 0, 0.0, ""(空串), [](空列表),
    #   ()(空元组), {}(空字典), set()(空集合), frozenset()
    # 其他一切都是 True（truthy）
    print(f"bool(0) = {bool(0)}")          # False
    print(f"bool('') = {bool('')}")        # False
    print(f"bool([]) = {bool([])}")        # False
    print(f"bool(42) = {bool(42)}")        # True
    print(f"bool('hi') = {bool('hi')}")    # True

    # ── NoneType ──
    # None 是 Python 的"空值"，类似其他语言的 null/nil
    # 它是 NoneType 的唯一实例（单例模式）
    result = None
    print(f"result = {result}, type = {type(result)}")
    # ⚠️ 检查是否为 None 用 is，不用 ==
    if result is None:
        print("result is None —— 用 is 比较 None 是最佳实践")

    # ── str 字符串 ──（第 08 节详细讲）
    plain = "第一行\n第二行"      # 双引号，支持转义
    raw = r"原始字符串\n不转义"    # r 前缀 = raw string
    multi = """三引号
可以跨行"""
    print(plain)
    print(raw)
    print(multi)


# ───────────────────────────────────────────────────────────────
# 4. 可变 vs 不可变类型
# ───────────────────────────────────────────────────────────────
def demo_mutability():
    print("\n══════ 4. 可变 vs 不可变 ══════")

    # 不可变（immutable）：int, float, bool, str, tuple, frozenset, bytes
    # 可变（mutable）：    list, dict, set, bytearray

    # 不可变的影响：
    a = "hello"
    # a[0] = "H"  # ⚠️ TypeError: 'str' does not support item assignment
    a = "Hello"    # 这是重新绑定名字，不是修改原字符串对象
    print(f"a = {a}")

    # 不可变类型有"小整数缓存"优化
    x = 256
    y = 256
    print(f"x is y (256): {x is y}")   # True：Python 缓存 [-5, 256] 的整数
    x = 257
    y = 257
    print(f"x is y (257): {x is y}")   # ⚠️ 在脚本中可能 True（编译优化），
    # 但在交互式中通常 False。不要依赖 is 比较数值！永远用 ==


# ───────────────────────────────────────────────────────────────
# 5. 类型转换与类型检查
# ───────────────────────────────────────────────────────────────
def demo_type_conversion():
    print("\n══════ 5. 类型转换 ══════")

    # Python 也需要显式转换（但比 Go 宽松一些）
    a = 65
    f = float(a)       # int -> float
    s = str(a)         # int -> str  => "65"
    c = chr(a)         # int -> 字符  => "A"（Unicode 码点）
    print(f"float({a})={f}, str({a})='{s}', chr({a})='{c}'")

    # str -> int：必须是合法数字串
    n = int("42")
    # int("hello")   # ⚠️ ValueError!
    print(f"int('42') = {n}")

    # type() 查看类型，isinstance() 判断类型（推荐）
    print(f"type(42) = {type(42)}")
    print(f"isinstance(42, int) = {isinstance(42, int)}")
    # isinstance 支持多类型判断
    print(f"isinstance(42, (int, float)) = {isinstance(42, (int, float))}")

    # ⚠️ 与 Go 的关键差异：Python 是鸭子类型（duck typing），
    # 一般不显式检查类型，而是"能用就用，出错再说"（EAFP 原则）


# ───────────────────────────────────────────────────────────────
# 6. "常量"：Python 没有 const！
# ───────────────────────────────────────────────────────────────
# 惯例用全大写命名表示"请不要修改"，但语言层面不强制
MAX_RETRIES = 3
PI = 3.14159265358979
GREETING = "你好"

# Python 3.8+ 可以用 typing.Final 做类型检查层面的"常量"提示：
# from typing import Final
# MAX_RETRIES: Final = 3   # mypy 会警告对它的重新赋值


if __name__ == "__main__":
    demo_variables()
    demo_name_binding()
    demo_basic_types()
    demo_mutability()
    demo_type_conversion()

    print("\n══════ 6. '常量' ══════")
    print(f"MAX_RETRIES = {MAX_RETRIES}, PI = {PI}")
    print("Python 没有 const，全大写只是约定")
