# 10 · 装饰器与闭包深入 ⭐⭐

> 装饰器是 Python 元编程最日常的工具——理解闭包、自由变量和描述符协议，才能写出正确的装饰器。

---

## 1. 闭包的底层机制

### 自由变量与 cell 对象

```python
def make_counter():
    count = 0            # 自由变量
    def counter():
        nonlocal count
        count += 1
        return count
    return counter

c = make_counter()
print(c())   # 1
print(c())   # 2
```

闭包的内部结构：

```python
print(c.__code__.co_freevars)    # ('count',)
print(c.__closure__)             # (<cell at 0x...>,)
print(c.__closure__[0].cell_contents)  # 当前 count 值
```

- `co_freevars`：自由变量名列表
- `__closure__`：cell 对象元组，每个 cell 包装一个自由变量
- CPython 用 cell 对象实现间接引用，使得内外函数共享同一个变量

### 经典闭包陷阱

```python
# ⚠️ 循环变量捕获
funcs = [lambda: i for i in range(3)]
print([f() for f in funcs])   # [2, 2, 2]  不是 [0, 1, 2]！

# 原因：lambda 捕获的是变量 i 的引用（cell），不是值
# 循环结束后 i == 2，所有 lambda 看到的都是 2

# 修复 1：默认参数捕获当前值
funcs = [lambda i=i: i for i in range(3)]

# 修复 2：用工厂函数
def make_func(i):
    return lambda: i
funcs = [make_func(i) for i in range(3)]
```

---

## 2. 装饰器的执行时机

```python
@decorator
def func():
    pass

# 等价于：
func = decorator(func)
# ⚠️ decorator 在模块导入时就执行，不是在 func 被调用时！
```

这意味着装饰器常用于：
- 注册函数到全局注册表（Flask 的 `@app.route`）
- 编译时检查（参数验证装饰器）
- 生成代码（`@dataclass`）

---

## 3. 装饰器模板

### 无参装饰器

```python
import functools

def my_decorator(func):
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        # 前置逻辑
        result = func(*args, **kwargs)
        # 后置逻辑
        return result
    return wrapper
```

### 带参装饰器（三层嵌套）

```python
def repeat(n=2):
    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            for _ in range(n):
                result = func(*args, **kwargs)
            return result
        return wrapper
    return decorator

@repeat(3)
def greet(name):
    print(f"Hello, {name}")
```

### 可选参数装饰器（既能 `@deco` 也能 `@deco()`）

```python
def smart_decorator(_func=None, *, option="default"):
    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            print(f"option: {option}")
            return func(*args, **kwargs)
        return wrapper

    if _func is not None:
        return decorator(_func)   # @smart_decorator 无括号
    return decorator              # @smart_decorator() 有括号
```

---

## 4. functools.wraps 的重要性

```python
def bad_decorator(func):
    def wrapper(*args, **kwargs):
        return func(*args, **kwargs)
    return wrapper

@bad_decorator
def my_func():
    """文档字符串"""
    pass

print(my_func.__name__)    # "wrapper" ⚠️ 名字丢了！
print(my_func.__doc__)     # None ⚠️ 文档丢了！
help(my_func)              # 显示 wrapper 的信息
```

`@functools.wraps(func)` 复制了以下属性：
- `__name__`、`__qualname__`
- `__doc__`
- `__module__`
- `__dict__`
- `__wrapped__`（指向原函数，方便调试）

---

## 5. 用类实现装饰器

```python
class Retry:
    def __init__(self, max_attempts=3):
        self.max_attempts = max_attempts

    def __call__(self, func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            for attempt in range(self.max_attempts):
                try:
                    return func(*args, **kwargs)
                except Exception:
                    if attempt == self.max_attempts - 1:
                        raise
        return wrapper

@Retry(max_attempts=5)
def unstable():
    ...
```

---

## 6. 装饰器与描述符的交互

⚠️ 当装饰器返回的不是函数而是类实例时，可能失去方法绑定能力：

```python
class MyDecorator:
    def __init__(self, func):
        self.func = func
    def __call__(self, *args, **kwargs):
        return self.func(*args, **kwargs)

class MyClass:
    @MyDecorator
    def method(self):    # method 变成了 MyDecorator 实例
        pass

obj = MyClass()
obj.method()   # ⚠️ TypeError: method() missing 'self'
# 因为 MyDecorator 没有 __get__，不是描述符，不会绑定 self

# 修复：给 MyDecorator 加 __get__
import types
class FixedDecorator:
    def __init__(self, func):
        self.func = func
    def __call__(self, *args, **kwargs):
        return self.func(*args, **kwargs)
    def __get__(self, obj, objtype=None):
        if obj is None:
            return self
        return types.MethodType(self, obj)
```

---

## 高频面试题

**Q1：闭包是什么？自由变量存在哪里？**
A：闭包是引用了外层函数局部变量的内层函数。自由变量存在 cell 对象中，通过 `__closure__` 属性访问。

**Q2：`@functools.wraps` 的作用？不加会怎样？**
A：复制原函数的元数据（名字、文档字符串等）到 wrapper。不加的话 `__name__`、`__doc__` 等都是 wrapper 的，调试和文档工具会显示错误信息。

**Q3：装饰器是什么时候执行的？**
A：模块导入时（定义时），不是函数调用时。`@deco` 在 `def` 语句执行后立即调用 `deco(func)`。

---

## 一句话总结

装饰器本质是"接受函数返回函数"的高阶函数，在模块导入时执行；闭包通过 cell 对象共享自由变量；永远加 `@functools.wraps` 保留原函数元数据。
