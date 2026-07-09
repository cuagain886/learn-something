# 05 · 元类（Metaclass） ⭐⭐

> "元类是创建类的类"——普通类创建实例，元类创建类。
> 99% 的 Python 开发者不需要写元类，但理解元类才能理解 Python 的类型系统。

---

## 1. 类的创建过程

```python
class MyClass:
    x = 10
    def method(self):
        pass

# 等价于：
MyClass = type("MyClass", (object,), {"x": 10, "method": method})
```

`type` 有两个用途：
1. `type(obj)` → 返回对象的类型
2. `type(name, bases, dict)` → **创建一个新类**

```python
# type 动态创建类
Dog = type("Dog", (), {"speak": lambda self: "Woof!"})
d = Dog()
print(d.speak())  # Woof!
```

---

## 2. 自定义元类

```python
class MyMeta(type):
    def __new__(mcs, name, bases, namespace):
        """在类对象创建之前调用"""
        print(f"创建类: {name}")
        # 可以修改 namespace（类的属性字典）
        cls = super().__new__(mcs, name, bases, namespace)
        return cls

    def __init__(cls, name, bases, namespace):
        """在类对象创建之后调用"""
        super().__init__(name, bases, namespace)

class MyClass(metaclass=MyMeta):  # 指定元类
    pass
# 输出：创建类: MyClass
```

### 类创建的完整流程

```
1. 执行类体（class body）-> 得到命名空间 dict
2. 调用 metaclass.__new__(mcs, name, bases, namespace) -> 创建类对象
3. 调用 metaclass.__init__(cls, name, bases, namespace) -> 初始化类对象
```

---

## 3. 元类的实用案例

### 案例 1：自动注册子类

```python
class PluginMeta(type):
    registry = {}

    def __init__(cls, name, bases, namespace):
        super().__init__(name, bases, namespace)
        if bases:  # 排除基类自身
            PluginMeta.registry[name] = cls

class Plugin(metaclass=PluginMeta):
    pass

class AuthPlugin(Plugin):    # 自动注册
    pass

class CachePlugin(Plugin):   # 自动注册
    pass

print(PluginMeta.registry)   # {'AuthPlugin': <class...>, 'CachePlugin': <class...>}
```

### 案例 2：强制子类实现某些方法

```python
class InterfaceMeta(type):
    def __init__(cls, name, bases, namespace):
        super().__init__(name, bases, namespace)
        if bases:  # 子类
            for method in getattr(bases[0], '_required_methods', []):
                if method not in namespace:
                    raise TypeError(f"{name} must implement {method}()")

class Serializable(metaclass=InterfaceMeta):
    _required_methods = ['serialize', 'deserialize']

# class BadImpl(Serializable):
#     pass
# TypeError: BadImpl must implement serialize()
```

---

## 4. `__init_subclass__`：轻量替代元类（Python 3.6+）

大多数元类的使用场景可以用 `__init_subclass__` 替代：

```python
class Plugin:
    _registry = {}

    def __init_subclass__(cls, **kwargs):
        super().__init_subclass__(**kwargs)
        Plugin._registry[cls.__name__] = cls

class AuthPlugin(Plugin):     # 自动调用 __init_subclass__
    pass

print(Plugin._registry)       # {'AuthPlugin': <class 'AuthPlugin'>}
```

⭐ **推荐优先使用 `__init_subclass__`**，比元类简单得多。

---

## 5. 面试中的元类问题

**Q1：什么是元类？**
A：元类是创建类的类。普通类是 `type` 的实例，自定义元类继承 `type` 来定制类的创建过程。

**Q2：`type` 和 `object` 的关系？**
A：`type` 是所有类的元类（包括自身），`object` 是所有类的基类（包括 `type`）。二者互为实例和子类，这个"鸡蛋问题"由 CPython 在启动时特殊处理。

**Q3：什么时候需要用元类？**
A：极少数情况：ORM 框架（Django Model）、序列化框架、API 框架的声明式语法。大多数场景用 `__init_subclass__`、类装饰器或描述符就够了。

**Q4：`class Foo(metaclass=MyMeta)` 的执行流程？**
A：1) 执行 class body 得到 namespace；2) 调用 `MyMeta.__new__` 创建类对象；3) 调用 `MyMeta.__init__` 初始化类对象。

---

## 一句话总结

元类是"类的类"，通过继承 `type` 定制类的创建过程；实际开发中 99% 的场景用 `__init_subclass__` 或类装饰器替代即可。
