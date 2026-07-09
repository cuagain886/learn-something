"""
═══════════════════════════════════════════════════════════════════

    11_inheritance —— 继承与多态

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. 单继承与方法覆写
 2. super() 调用父类方法
 3. 多继承与 MRO（方法解析顺序）
 4. 抽象基类（ABC）
 5. 鸭子类型与协议（Python 的"接口"）

【运行】python main.py

【与其他语言的对照】
  - Go 没有继承，只有组合（嵌入）+ 接口（隐式实现）
  - Python 支持多继承（C++也支持，Java/Go 不支持）
  - Python 用 ABC 实现抽象接口，但更推崇鸭子类型
  - MRO（C3 线性化）是 Python 多继承的核心，面试会问
"""
from abc import ABC, abstractmethod


# ───────────────────────────────────────────────────────────────
# 1. 单继承
# ───────────────────────────────────────────────────────────────
class Animal:
    def __init__(self, name, age):
        self.name = name
        self.age = age

    def speak(self):
        return f"{self.name} makes a sound"

    def info(self):
        return f"{self.name}, {self.age} years old"


class Dog(Animal):   # Dog 继承 Animal
    def __init__(self, name, age, breed):
        super().__init__(name, age)   # ⭐ 调用父类的 __init__
        self.breed = breed

    def speak(self):   # 方法覆写（override）
        return f"{self.name} says: Woof!"

    def fetch(self):
        return f"{self.name} fetches the ball"


class Cat(Animal):
    def speak(self):
        return f"{self.name} says: Meow!"


def demo_single_inheritance():
    print("══════ 1. 单继承 ══════")

    dog = Dog("Buddy", 3, "Golden Retriever")
    cat = Cat("Whiskers", 2)

    print(dog.speak())        # 覆写的方法
    print(dog.info())         # 继承的方法
    print(dog.fetch())        # Dog 独有的方法
    print(cat.speak())

    # isinstance 检查继承链
    print(f"dog is Animal: {isinstance(dog, Animal)}")   # True
    print(f"dog is Dog: {isinstance(dog, Dog)}")         # True

    # issubclass 检查类的继承关系
    print(f"Dog is subclass of Animal: {issubclass(Dog, Animal)}")

    # ⭐ 多态：同一接口，不同实现
    animals = [dog, cat, Animal("Unknown", 1)]
    for animal in animals:
        print(f"  {animal.speak()}")


# ───────────────────────────────────────────────────────────────
# 2. 多继承与 MRO
# ───────────────────────────────────────────────────────────────
class Flyable:
    def fly(self):
        return "I can fly!"

    def action(self):
        return "Flyable.action"


class Swimmable:
    def swim(self):
        return "I can swim!"

    def action(self):
        return "Swimmable.action"


class Duck(Animal,Swimmable , Flyable):
    """鸭子：继承了 Animal、Flyable、Swimmable"""
    def speak(self):
        return f"{self.name} says: Quack!"


def demo_multiple_inheritance():
    print("\n══════ 2. 多继承与 MRO ══════")

    duck = Duck("Donald", 2)
    print(duck.speak())
    print(duck.fly())
    print(duck.swim())

    # 当多个父类有同名方法时，谁优先？
    # 答：按 MRO（Method Resolution Order）顺序
    print(f"action(): {duck.action()}")   # Flyable.action（按 MRO 顺序）

    # 查看 MRO
    print(f"MRO: {[cls.__name__ for cls in Duck.__mro__]}")
    # [Duck, Animal, Flyable, Swimmable, object]
    # ⚠️ Python 使用 C3 线性化算法计算 MRO，保证：
    #   1. 子类在父类之前
    #   2. 声明顺序被保留（Duck(Animal, Flyable, Swimmable)）
    #   3. 共同父类 object 在最后


# ───────────────────────────────────────────────────────────────
# 3. super() 与多继承的协作
# ───────────────────────────────────────────────────────────────
class A:
    def greet(self):
        print("  A.greet")

class B(A):
    def greet(self):
        print("  B.greet")
        super().greet()      # 按 MRO 调用下一个类的方法

class C(A):
    def greet(self):
        print("  C.greet")
        super().greet()

class D(B, C):
    def greet(self):
        print("  D.greet")
        super().greet()      # super() 按 MRO 走，不是"调用父类"


def demo_super_mro():
    print("\n══════ 3. super() 与 MRO 协作 ══════")

    d = D()
    d.greet()
    # 输出顺序：D -> B -> C -> A
    # 因为 MRO = [D, B, C, A, object]
    # super() 按 MRO 链式调用，每个方法只调用一次（协作式多继承）

    print(f"D 的 MRO: {[cls.__name__ for cls in D.__mro__]}")


# ───────────────────────────────────────────────────────────────
# 4. 抽象基类（ABC）
# ───────────────────────────────────────────────────────────────
class Shape(ABC):
    """抽象基类：不能直接实例化，子类必须实现抽象方法"""

    @abstractmethod
    def area(self):
        """计算面积（子类必须实现）"""
        pass

    @abstractmethod
    def perimeter(self):
        """计算周长（子类必须实现）"""
        pass

    def describe(self):
        """普通方法：子类可以直接用"""
        return f"{self.__class__.__name__}: 面积={self.area():.2f}, 周长={self.perimeter():.2f}"


class Circle(Shape):
    def __init__(self, radius):
        self.radius = radius

    def area(self):
        return 3.14159 * self.radius ** 2

    def perimeter(self):
        return 2 * 3.14159 * self.radius


class Rectangle(Shape):
    def __init__(self, width, height):
        self.width = width
        self.height = height

    def area(self):
        return self.width * self.height

    def perimeter(self):
        return 2 * (self.width + self.height)


def demo_abc():
    print("\n══════ 4. 抽象基类 ABC ══════")

    # shape = Shape()  # ⚠️ TypeError: Can't instantiate abstract class

    shapes = [Circle(5), Rectangle(3, 4)]
    for s in shapes:
        print(f"  {s.describe()}")


# ───────────────────────────────────────────────────────────────
# 5. 鸭子类型（Duck Typing）
# ───────────────────────────────────────────────────────────────
class JsonWriter:
    """写 JSON 到任何有 write() 方法的对象"""
    def save(self, data, target):
        import json
        target.write(json.dumps(data))


class FakeFile:
    """只要有 write() 方法就能用，不需要继承任何类"""
    def __init__(self):
        self.content = ""

    def write(self, text):
        self.content += text


def demo_duck_typing():
    print("\n══════ 5. 鸭子类型 ══════")

    # "如果它走起来像鸭子、叫起来像鸭子，那它就是鸭子"
    # Python 不关心对象的类型，只关心它有没有需要的方法/属性

    writer = JsonWriter()
    fake = FakeFile()
    writer.save({"name": "Alice"}, fake)   # FakeFile 有 write()，就能用
    print(f"  写入内容: {fake.content}")

    # 对比 Go 的接口：Go 也是隐式实现，但通过编译期接口检查
    # Python 完全是运行时检查——调用时才发现有没有那个方法

    # Python 3.8+ 可以用 Protocol（typing 模块）做静态类型检查的鸭子类型
    from typing import Protocol

    class Writable(Protocol):
        def write(self, text: str) -> None: ...

    def save_data(target: Writable):
        target.write("hello")

    save_data(fake)  # mypy 可以检查 FakeFile 是否满足 Writable 协议
    print("  Protocol 类型检查通过")


if __name__ == "__main__":
    demo_single_inheritance()
    demo_multiple_inheritance()
    demo_super_mro()
    demo_abc()
    demo_duck_typing()
