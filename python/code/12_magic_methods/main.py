"""
═══════════════════════════════════════════════════════════════════

    12_magic_methods —— 魔术方法（dunder methods）

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. 什么是魔术方法（双下划线方法 __xxx__）
 2. 对象表示：__str__、__repr__
 3. 运算符重载：__add__、__eq__、__lt__ 等
 4. 容器协议：__len__、__getitem__、__iter__
 5. 可调用对象：__call__
 6. 上下文管理器：__enter__、__exit__（第 17 节详讲）

【运行】python main.py

【与其他语言的对照】
  - 魔术方法 ≈ Go 实现 Stringer/sort.Interface 等接口
  - Python 通过魔术方法让自定义类融入语言的内置语法（+、[]、for、with 等）
  - 这是 Python "一切皆对象 + 协议" 设计哲学的核心
"""


# ───────────────────────────────────────────────────────────────
# 1. 对象表示
# ───────────────────────────────────────────────────────────────
class Vector:
    """二维向量，演示常用魔术方法"""

    def __init__(self, x, y):
        self.x = x
        self.y = y

    def __str__(self):
        """用户友好的字符串（print、str() 调用）"""
        return f"Vector({self.x}, {self.y})"

    def __repr__(self):
        """开发者友好的字符串（交互式解释器、调试时显示）
        惯例：输出能重建对象的表达式"""
        return f"Vector({self.x!r}, {self.y!r})"

    # ───────────────────────────────────────────────────────────
    # 2. 运算符重载
    # ───────────────────────────────────────────────────────────

    def __add__(self, other):
        """v1 + v2"""
        return Vector(self.x + other.x, self.y + other.y)

    def __sub__(self, other):
        """v1 - v2"""
        return Vector(self.x - other.x, self.y - other.y)

    def __mul__(self, scalar):
        """v * n（向量乘标量）"""
        return Vector(self.x * scalar, self.y * scalar)

    def __rmul__(self, scalar):
        """n * v（反向乘法，当左操作数不支持 __mul__ 时调用）"""
        return self.__mul__(scalar)

    def __neg__(self):
        """-v"""
        return Vector(-self.x, -self.y)

    def __abs__(self):
        """abs(v) -> 向量的模"""
        return (self.x ** 2 + self.y ** 2) ** 0.5

    # ───────────────────────────────────────────────────────────
    # 3. 比较运算符
    # ───────────────────────────────────────────────────────────

    def __eq__(self, other):
        """v1 == v2"""
        if not isinstance(other, Vector):
            return NotImplemented   # 让 Python 尝试 other.__eq__(self)
        return self.x == other.x and self.y == other.y

    def __lt__(self, other):
        """v1 < v2（按模比较）"""
        return abs(self) < abs(other)

    def __hash__(self):
        """实现 __eq__ 后必须实现 __hash__（否则变得不可哈希）"""
        return hash((self.x, self.y))

    # ───────────────────────────────────────────────────────────
    # 4. 容器协议
    # ───────────────────────────────────────────────────────────

    def __len__(self):
        """len(v) -> 维度数"""
        return 2

    def __getitem__(self, index):
        """v[0], v[1] —— 让向量支持索引"""
        if index == 0:
            return self.x
        elif index == 1:
            return self.y
        raise IndexError(f"Vector index {index} out of range")

    def __iter__(self):
        """for x in v —— 让向量支持迭代"""
        yield self.x
        yield self.y

    def __contains__(self, value):
        """value in v"""
        return value == self.x or value == self.y

    # ───────────────────────────────────────────────────────────
    # 5. 布尔值
    # ───────────────────────────────────────────────────────────

    def __bool__(self):
        """bool(v) —— 零向量为 False"""
        return self.x != 0 or self.y != 0


def demo_vector():
    print("══════ 1-5. Vector 魔术方法演示 ══════")

    v1 = Vector(3, 4)
    v2 = Vector(1, 2)

    # __str__ / __repr__
    print(f"str: {v1}")
    print(f"repr: {repr(v1)}")

    # 运算符重载
    print(f"v1 + v2 = {v1 + v2}")
    print(f"v1 - v2 = {v1 - v2}")
    print(f"v1 * 3 = {v1 * 3}")
    print(f"3 * v1 = {3 * v1}")       # __rmul__
    print(f"-v1 = {-v1}")
    print(f"|v1| = {abs(v1)}")

    # 比较
    print(f"v1 == Vector(3,4): {v1 == Vector(3, 4)}")
    print(f"v2 < v1: {v2 < v1}")

    # 容器协议
    print(f"len(v1) = {len(v1)}")
    print(f"v1[0] = {v1[0]}, v1[1] = {v1[1]}")
    print(f"3 in v1: {3 in v1}")

    # 迭代
    x, y = v1    # 解包（因为实现了 __iter__）
    print(f"解包: x={x}, y={y}")

    # 布尔
    print(f"bool(v1): {bool(v1)}")
    print(f"bool(Vector(0,0)): {bool(Vector(0, 0))}")

    # 可以作为字典 key（因为实现了 __hash__）
    d = {v1: "点A", v2: "点B"}
    print(f"字典: {d[Vector(3, 4)]}")


# ───────────────────────────────────────────────────────────────
# 6. __call__：可调用对象
# ───────────────────────────────────────────────────────────────
class Multiplier:
    """实现 __call__ 让实例像函数一样被调用"""

    def __init__(self, factor):
        self.factor = factor

    def __call__(self, value):
        return value * self.factor


def demo_callable():
    print("\n══════ 6. __call__ 可调用对象 ══════")

    double = Multiplier(2)
    triple = Multiplier(3)

    # 像调用函数一样使用
    print(f"double(21) = {double(21)}")   # 42
    print(f"triple(7) = {triple(7)}")     # 21

    # 判断是否可调用
    print(f"callable(double): {callable(double)}")
    print(f"callable(42): {callable(42)}")

    # 实际应用：带状态的函数（替代闭包），装饰器类


# ───────────────────────────────────────────────────────────────
# 7. 常用魔术方法速查
# ───────────────────────────────────────────────────────────────
def demo_cheatsheet():
    print("\n══════ 7. 常用魔术方法速查 ══════")

    info = """
    ┌────────────────┬─────────────────────┬──────────────────────┐
    │ 类别           │ 方法                │ 触发时机              │
    ├────────────────┼─────────────────────┼──────────────────────┤
    │ 创建/销毁      │ __init__            │ 实例化               │
    │                │ __del__             │ 垃圾回收前            │
    │                │ __new__             │ 创建实例（元类用）     │
    ├────────────────┼─────────────────────┼──────────────────────┤
    │ 字符串表示      │ __str__             │ str() / print()      │
    │                │ __repr__            │ repr() / 交互式       │
    │                │ __format__          │ f-string / format()  │
    ├────────────────┼─────────────────────┼──────────────────────┤
    │ 比较           │ __eq__ __ne__       │ == !=                │
    │                │ __lt__ __le__       │ <  <=                │
    │                │ __gt__ __ge__       │ >  >=                │
    ├────────────────┼─────────────────────┼──────────────────────┤
    │ 算术           │ __add__ __sub__     │ +  -                 │
    │                │ __mul__ __truediv__ │ *  /                 │
    │                │ __floordiv__ __mod__│ // %                 │
    │                │ __pow__             │ **                   │
    ├────────────────┼─────────────────────┼──────────────────────┤
    │ 容器           │ __len__             │ len()                │
    │                │ __getitem__         │ obj[key]             │
    │                │ __setitem__         │ obj[key] = val       │
    │                │ __delitem__         │ del obj[key]         │
    │                │ __contains__        │ item in obj          │
    │                │ __iter__            │ for ... in obj       │
    ├────────────────┼─────────────────────┼──────────────────────┤
    │ 其他           │ __call__            │ obj()                │
    │                │ __hash__            │ hash()               │
    │                │ __bool__            │ bool() / if obj      │
    │                │ __enter__ __exit__  │ with obj             │
    │                │ __getattr__         │ 属性不存在时          │
    └────────────────┴─────────────────────┴──────────────────────┘
    """
    print(info)

    # ⭐ 小技巧：用 @functools.total_ordering 减少比较方法的编写
    # 只需要实现 __eq__ 和一个排序方法（如 __lt__），其余自动生成
    from functools import total_ordering

    @total_ordering
    class Score:
        def __init__(self, value):
            self.value = value
        def __eq__(self, other):
            return self.value == other.value
        def __lt__(self, other):
            return self.value < other.value

    s1, s2 = Score(85), Score(90)
    print(f"Score(85) <= Score(90): {s1 <= s2}")   # 自动生成 __le__
    print(f"Score(85) > Score(90): {s1 > s2}")     # 自动生成 __gt__


if __name__ == "__main__":
    demo_vector()
    demo_callable()
    demo_cheatsheet()
