"""
═══════════════════════════════════════════════════════════════════

    10_classes —— 类与对象：Python 的 OOP

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. 类定义、__init__ 构造方法、实例属性与类属性
 2. 方法类型：实例方法、类方法、静态方法
 3. 属性访问控制：name mangling、property
 4. 数据类 dataclass（Python 3.7+）

【运行】python main.py

【与其他语言的对照】
  - Python 有完整的 OOP：类、继承、多态、封装
  - 没有严格的 private/public 关键字（靠命名约定）
  - Go 没有类，用 struct + 方法；Python 的类更传统
  - self 必须显式写在方法参数中（Go 的接收者也是显式的）
  - Python 支持多继承（Go 只有组合）
"""


# ───────────────────────────────────────────────────────────────
# 1. 类定义与实例化
# ───────────────────────────────────────────────────────────────
class Book:
    """图书类 —— 演示基本类定义"""

    # 类属性：属于类本身，所有实例共享
    category = "未分类"

    def __init__(self, title, author, price=0.0):
        """构造方法：创建实例时自动调用

        self 是实例自身的引用（类似 Go 方法的接收者）
        ⚠️ self 不是关键字，只是约定名称，但必须是第一个参数
        """
        # 实例属性：每个实例独立拥有
        self.title = title
        self.author = author
        self.price = price

    def display(self):
        """实例方法：第一个参数是 self"""
        print(f"  《{self.title}》 by {self.author}, ¥{self.price}")

    def __str__(self):
        """定义 print() 和 str() 的输出"""
        return f"Book('{self.title}', '{self.author}')"

    def __repr__(self):
        """定义开发者友好的字符串表示（调试用）"""
        return f"Book(title={self.title!r}, author={self.author!r}, price={self.price})"


def demo_basics():
    print("══════ 1. 类的基本使用 ══════")

    # 实例化（不需要 new 关键字）
    book1 = Book("Python 编程", "Guido", 99.0)
    book2 = Book("设计模式", "GoF")   # price 使用默认值

    book1.display()
    book2.display()

    # 访问属性
    print(f"title: {book1.title}")
    print(f"str(): {book1}")          # 调用 __str__
    print(f"repr(): {repr(book1)}")   # 调用 __repr__

    # 动态添加属性（Python 的灵活性）
    book1.isbn = "978-xxx"            # ⚠️ 可以随时给实例添加新属性！
    print(f"动态属性: {book1.isbn}")

    # 类属性 vs 实例属性
    print(f"类属性 category: {Book.category}")
    print(f"实例访问类属性: {book1.category}")
    book1.category = "编程"           # ⚠️ 这创建了实例属性，遮蔽了类属性
    print(f"book1.category: {book1.category}")  # 编程（实例属性）
    print(f"book2.category: {book2.category}")  # 未分类（仍是类属性）


# ───────────────────────────────────────────────────────────────
# 2. 方法类型
# ───────────────────────────────────────────────────────────────
class MathHelper:
    """演示三种方法类型"""

    pi = 3.14159

    def __init__(self, value):
        self.value = value

    # 实例方法：操作实例数据
    def double(self):
        return self.value * 2

    # 类方法：操作类级别数据，第一个参数是 cls（类本身）
    @classmethod
    def from_string(cls, s):
        """工厂方法：从字符串创建实例"""
        return cls(float(s))

    # 静态方法：不需要访问类或实例，只是逻辑上属于这个类
    @staticmethod
    def add(a, b):
        return a + b


def demo_methods():
    print("\n══════ 2. 方法类型 ══════")

    m = MathHelper(21)
    print(f"实例方法 double(): {m.double()}")      # 42

    m2 = MathHelper.from_string("3.14")
    print(f"类方法 from_string(): {m2.value}")      # 3.14

    print(f"静态方法 add(3,4): {MathHelper.add(3, 4)}")  # 7


# ───────────────────────────────────────────────────────────────
# 3. 属性访问控制
# ───────────────────────────────────────────────────────────────
class Account:
    """演示属性访问控制"""

    def __init__(self, owner, balance):
        self.owner = owner        # 公开属性
        self._bank = "默认银行"    # _单下划线：约定"内部使用"，但仍可访问
        self.__balance = balance   # __双下划线：名称改编（name mangling）

    # ⭐ property：用方法实现属性访问（类似 Go 的 getter/setter）
    @property
    def balance(self):
        """只读属性（getter）"""
        return self.__balance

    @balance.setter
    def balance(self, value):
        """可写属性（setter），可以加验证逻辑"""
        if value < 0:
            raise ValueError("余额不能为负")
        self.__balance = value

    @property
    def info(self):
        """计算属性（只有 getter，只读）"""
        return f"{self.owner} @ {self._bank}: ¥{self.__balance}"


def demo_access_control():
    print("\n══════ 3. 属性访问控制 ══════")

    acc = Account("Alice", 1000)

    # 公开属性
    print(f"owner: {acc.owner}")

    # 约定内部属性（仍可访问，只是约定）
    print(f"_bank: {acc._bank}")

    # 双下划线属性：名称改编为 _ClassName__attr
    # print(acc.__balance)  # ⚠️ AttributeError!
    print(f"_Account__balance: {acc._Account__balance}")  # 技术上仍可访问

    # property 像属性一样使用
    print(f"property balance: {acc.balance}")
    acc.balance = 2000
    print(f"setter 后: {acc.balance}")

    # acc.balance = -100  # ⚠️ ValueError: 余额不能为负

    print(f"info: {acc.info}")


# ───────────────────────────────────────────────────────────────
# 4. dataclass（Python 3.7+）
# ───────────────────────────────────────────────────────────────
from dataclasses import dataclass, field


@dataclass
class Point:
    """数据类自动生成 __init__、__repr__、__eq__ 等"""
    x: float
    y: float
    label: str = "origin"    # 默认值


@dataclass(frozen=True)     # frozen=True -> 不可变（类似 Go 的值类型语义）
class Color:
    r: int
    g: int
    b: int


@dataclass
class Student:
    name: str
    age: int
    grades: list = field(default_factory=list)   # ⚠️ 可变默认值用 field()


def demo_dataclass():
    print("\n══════ 4. dataclass ══════")

    p1 = Point(3, 4)
    p2 = Point(3, 4)
    print(f"p1 = {p1}")             # 自动生成 __repr__
    print(f"p1 == p2: {p1 == p2}")  # 自动生成 __eq__：True

    red = Color(255, 0, 0)
    print(f"color = {red}")
    # red.r = 128  # ⚠️ FrozenInstanceError（frozen=True）

    s1 = Student("Alice", 20)
    s1.grades.append(95)
    s2 = Student("Bob", 21)
    print(f"s1 = {s1}")
    print(f"s2 = {s2}")   # grades 是独立的空列表，不会共享


# ───────────────────────────────────────────────────────────────
# 5. __slots__：限制实例属性（优化内存）
# ───────────────────────────────────────────────────────────────
class OptimizedPoint:
    __slots__ = ("x", "y")   # 只允许这些属性，不再有 __dict__

    def __init__(self, x, y):
        self.x = x
        self.y = y


def demo_slots():
    print("\n══════ 5. __slots__ ══════")

    p = OptimizedPoint(3, 4)
    print(f"OptimizedPoint: ({p.x}, {p.y})")
    # p.z = 5  # ⚠️ AttributeError: 'OptimizedPoint' object has no attribute 'z'

    # __slots__ 的优势：
    # 1. 节省内存（没有 __dict__，大量实例时效果显著）
    # 2. 更快的属性访问
    # 3. 防止意外添加属性（拼写错误时直接报错）

    import sys
    regular = Point(3, 4)
    optimized = OptimizedPoint(3, 4)
    print(f"  Point 内存:          {sys.getsizeof(regular.__dict__)} bytes (__dict__)")
    print(f"  OptimizedPoint 内存: 无 __dict__（用 slot 描述符）")


if __name__ == "__main__":
    demo_basics()
    demo_methods()
    demo_access_control()
    demo_dataclass()
    demo_slots()
