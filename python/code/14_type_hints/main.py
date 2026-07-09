"""
═══════════════════════════════════════════════════════════════════

    14_type_hints —— 类型提示（Type Hints）

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. 函数参数和返回值的类型标注
 2. 常用类型：Optional、Union、list、dict、tuple
 3. 泛型类型与 TypeVar
 4. Protocol（结构化子类型 / 静态鸭子类型）
 5. 类型检查工具 mypy

【运行】python main.py
       mypy main.py       # 静态类型检查（需安装 mypy）

【与其他语言的对照】
  - Go 是静态类型，类型检查在编译期
  - Python 的类型提示是【可选的】，运行时不强制——只是给人和工具看的
  - TypeScript 也是可选类型提示 + 静态检查的模式
  - Python 3.5 引入 typing，3.9+ 简化了语法（list[int] 代替 List[int]）
"""
from __future__ import annotations   # 使所有类型注解延迟求值（3.7+）

from typing import (
    TypeVar, Generic, Protocol,
    Any, Union, Optional, Callable,
    TypeAlias, Literal, TypeGuard,
)
from dataclasses import dataclass


# ───────────────────────────────────────────────────────────────
# 1. 基本类型标注
# ───────────────────────────────────────────────────────────────
def demo_basic_hints():
    print("══════ 1. 基本类型标注 ══════")

    # 函数参数和返回值标注
    def greet(name: str) -> str:
        return f"Hello, {name}!"

    # 变量标注（Python 3.6+）
    age: int = 30
    names: list[str] = ["Alice", "Bob"]   # 3.9+ 可以直接用 list[str]
    scores: dict[str, int] = {"math": 95}
    point: tuple[float, float] = (3.0, 4.0)
    matrix: list[list[int]] = [[1, 2], [3, 4]]

    print(f"greet: {greet('Python')}")
    print(f"names: {names}")

    # ⚠️ 类型提示不影响运行！传错类型照样能跑（但 mypy 会报错）
    result = greet(42)   # type: ignore  # 运行时不报错，mypy 会报错
    print(f"传 int 给 str 参数: {result}")


# ───────────────────────────────────────────────────────────────
# 2. Optional、Union、特殊类型
# ───────────────────────────────────────────────────────────────
def demo_special_types():
    print("\n══════ 2. Optional / Union ══════")

    # Optional[X] = X | None（可能是 X 也可能是 None）
    def find_user(user_id: int) -> Optional[str]:
        users = {1: "Alice", 2: "Bob"}
        return users.get(user_id)

    print(f"find_user(1): {find_user(1)}")
    print(f"find_user(99): {find_user(99)}")

    # Union[X, Y]：可以是 X 或 Y
    # Python 3.10+ 可以用 X | Y 语法
    def process(value: int | str) -> str:
        if isinstance(value, int):
            return f"数字: {value}"
        return f"字符串: {value}"

    print(f"process(42): {process(42)}")
    print(f"process('hi'): {process('hi')}")

    # Literal：限定字面值
    def set_mode(mode: Literal["read", "write", "append"]) -> str:
        return f"模式: {mode}"

    print(f"set_mode: {set_mode('read')}")

    # Any：任意类型（⚠️ 尽量少用）
    def log(message: Any) -> None:
        print(f"  LOG: {message}")

    log("hello")
    log(42)


# ───────────────────────────────────────────────────────────────
# 3. Callable 类型
# ───────────────────────────────────────────────────────────────
def demo_callable():
    print("\n══════ 3. Callable ══════")

    # Callable[[参数类型...], 返回类型]
    def apply(func: Callable[[int, int], int], a: int, b: int) -> int:
        return func(a, b)

    result = apply(lambda x, y: x + y, 3, 4)
    print(f"apply(add, 3, 4) = {result}")

    # 接受任意参数的 Callable
    def run(func: Callable[..., None]) -> None:
        func()

    run(lambda: print("  lambda executed"))


# ───────────────────────────────────────────────────────────────
# 4. TypeVar 与泛型
# ───────────────────────────────────────────────────────────────
T = TypeVar("T")
K = TypeVar("K")
V = TypeVar("V")

def first(items: list[T]) -> T | None:
    """泛型函数：返回列表第一个元素"""
    return items[0] if items else None


# 受限的 TypeVar
Number = TypeVar("Number", int, float)

def add(a: Number, b: Number) -> Number:
    return a + b


# 泛型类
class Stack(Generic[T]):
    """泛型栈"""
    def __init__(self) -> None:
        self._items: list[T] = []

    def push(self, item: T) -> None:
        self._items.append(item)

    def pop(self) -> T:
        return self._items.pop()

    def __len__(self) -> int:
        return len(self._items)


def demo_generics():
    print("\n══════ 4. 泛型 ══════")

    print(f"first([1,2,3]) = {first([1, 2, 3])}")
    print(f"first(['a','b']) = {first(['a', 'b'])}")
    print(f"first([]) = {first([])}")

    print(f"add(1, 2) = {add(1, 2)}")
    print(f"add(1.5, 2.5) = {add(1.5, 2.5)}")

    # 泛型类使用
    stack: Stack[int] = Stack()
    stack.push(1)
    stack.push(2)
    stack.push(3)
    print(f"Stack pop: {stack.pop()}, {stack.pop()}")

    # Python 3.12+ 新语法（更简洁）：
    # def first[T](items: list[T]) -> T | None: ...
    # class Stack[T]: ...


# ───────────────────────────────────────────────────────────────
# 5. Protocol（结构化子类型）
# ───────────────────────────────────────────────────────────────
class Drawable(Protocol):
    """定义一个协议：任何有 draw() 方法的对象都满足"""
    def draw(self) -> str: ...


class Circle:
    def __init__(self, radius: float):
        self.radius = radius

    def draw(self) -> str:
        return f"Drawing circle with radius {self.radius}"


class Square:
    def __init__(self, side: float):
        self.side = side

    def draw(self) -> str:
        return f"Drawing square with side {self.side}"


def render(shape: Drawable) -> None:
    """接受任何满足 Drawable 协议的对象"""
    print(f"  {shape.draw()}")


def demo_protocol():
    print("\n══════ 5. Protocol ══════")

    # Circle 和 Square 不需要继承 Drawable
    # 只要有 draw() -> str 方法就满足协议（静态鸭子类型）
    render(Circle(5))
    render(Square(3))

    # 这和 Go 的接口理念非常相似：隐式实现，结构化匹配
    print("  Protocol ≈ Go 的 interface：不需要显式声明实现")


# ───────────────────────────────────────────────────────────────
# 6. TypeAlias 与实用技巧
# ───────────────────────────────────────────────────────────────
# 类型别名：简化复杂类型
UserId: TypeAlias = int
UserMap: TypeAlias = dict[UserId, str]
Matrix: TypeAlias = list[list[float]]
Callback: TypeAlias = Callable[[str], None]


@dataclass
class Config:
    host: str = "localhost"
    port: int = 8080
    debug: bool = False
    tags: list[str] | None = None


def demo_practical():
    print("\n══════ 6. 实用技巧 ══════")

    users: UserMap = {1: "Alice", 2: "Bob"}
    print(f"UserMap: {users}")

    config = Config(host="0.0.0.0", debug=True, tags=["api", "v2"])
    print(f"Config: {config}")

    # TypeGuard：类型收窄
    def is_string_list(val: list[Any]) -> TypeGuard[list[str]]:
        return all(isinstance(x, str) for x in val)

    data: list[Any] = ["a", "b", "c"]
    if is_string_list(data):
        # mypy 知道这里 data 是 list[str]
        print(f"  字符串列表: {', '.join(data)}")

    print("\n  ⭐ 类型提示最佳实践：")
    print("  1. 公开 API 加类型标注，内部辅助函数可选")
    print("  2. 优先用 3.9+ 内置泛型语法（list[int] 而非 List[int]）")
    print("  3. 用 Protocol 代替 ABC 做接口约束")
    print("  4. 配合 mypy --strict 做静态检查")


if __name__ == "__main__":
    demo_basic_hints()
    demo_special_types()
    demo_callable()
    demo_generics()
    demo_protocol()
    demo_practical()
