# 04 · 描述符协议（Descriptor Protocol） ⭐⭐

> 描述符是 Python 属性访问的底层机制——**property、classmethod、staticmethod、`__slots__` 底层都是描述符**。理解描述符就理解了 Python 的属性魔法。

---

## 1. 什么是描述符？

描述符是实现了以下任一方法的对象：

```python
class Descriptor:
    def __get__(self, obj, objtype=None):   # 读取属性时调用
        ...
    def __set__(self, obj, value):          # 设置属性时调用
        ...
    def __delete__(self, obj):              # 删除属性时调用
        ...
```

- **数据描述符**（data descriptor）：同时定义了 `__get__` 和 `__set__`（或 `__delete__`）
- **非数据描述符**（non-data descriptor）：只定义了 `__get__`

---

## 2. 描述符的查找优先级

当执行 `obj.attr` 时，Python 按以下优先级查找：

```
1. 数据描述符（类及 MRO 链上的）     ← 最高优先级
2. 实例的 __dict__
3. 非数据描述符 / 类属性
```

```python
class DataDesc:
    def __get__(self, obj, objtype=None):
        return "data descriptor"
    def __set__(self, obj, value):
        pass

class NonDataDesc:
    def __get__(self, obj, objtype=None):
        return "non-data descriptor"

class MyClass:
    data = DataDesc()
    nondata = NonDataDesc()

obj = MyClass()
obj.__dict__["data"] = "instance"
obj.__dict__["nondata"] = "instance"

print(obj.data)      # "data descriptor" —— 数据描述符优先于实例属性
print(obj.nondata)   # "instance" —— 实例属性优先于非数据描述符
```

**面试要点**：这个优先级解释了为什么 `property`（数据描述符）能拦截属性赋值，而普通方法（非数据描述符）不能。

---

## 3. property 就是描述符

```python
# property 的纯 Python 等价实现
class Property:
    def __init__(self, fget=None, fset=None, fdel=None):
        self.fget = fget
        self.fset = fset
        self.fdel = fdel

    def __get__(self, obj, objtype=None):
        if obj is None:
            return self
        return self.fget(obj)

    def __set__(self, obj, value):
        if self.fset is None:
            raise AttributeError("can't set attribute")
        self.fset(obj, value)
```

---

## 4. 函数也是描述符

Python 的函数实现了 `__get__`，这就是方法绑定的原理：

```python
class MyClass:
    def method(self):
        pass

obj = MyClass()

# 通过类访问：返回函数本身
print(MyClass.__dict__["method"])  # <function method>

# 通过实例访问：__get__ 被调用，返回绑定方法
print(obj.method)                  # <bound method method of <MyClass>>

# 等价于：
MyClass.__dict__["method"].__get__(obj, MyClass)
```

**面试要点**：这就是为什么 `obj.method()` 会自动传 `self` —— 描述符协议在属性访问时将函数绑定到实例。

---

## 5. 实用示例：带验证的属性描述符

```python
class Validated:
    def __init__(self, validator, name=None):
        self.validator = validator
        self.name = name

    def __set_name__(self, owner, name):
        self.name = name    # Python 3.6+：自动获取属性名

    def __get__(self, obj, objtype=None):
        if obj is None:
            return self
        return obj.__dict__.get(self.name)

    def __set__(self, obj, value):
        self.validator(value)
        obj.__dict__[self.name] = value

class User:
    name = Validated(lambda v: v if isinstance(v, str) and v else (_ for _ in ()).throw(ValueError("name required")))
    age = Validated(lambda v: v if isinstance(v, int) and 0 <= v <= 150 else (_ for _ in ()).throw(ValueError("invalid age")))
```

---

## 高频面试题

**Q1：什么是数据描述符和非数据描述符？区别是什么？**
A：数据描述符定义了 `__get__` + `__set__`（或 `__delete__`），优先级高于实例属性；非数据描述符只定义 `__get__`，优先级低于实例属性。

**Q2：为什么 `obj.method` 返回的是绑定方法而不是函数？**
A：因为函数实现了 `__get__` 描述符协议，通过实例访问时返回绑定方法（bound method），自动绑定 self。

**Q3：`__set_name__` 的作用？**
A：Python 3.6+ 在类创建时自动调用描述符的 `__set_name__(self, owner, name)`，让描述符知道自己被赋值给了哪个属性名。

---

## 一句话总结

描述符是 Python 属性访问的底层协议，数据描述符优先于实例属性，非数据描述符低于实例属性；property、方法绑定、classmethod、staticmethod 都是描述符的应用。
