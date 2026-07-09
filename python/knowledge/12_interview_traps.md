# 12 · 高频面试陷阱题集锦 ⭐⭐⭐

> 30+ 道 Python 面试常考的"输出什么？为什么？"题目。每道题先想答案再看解析。

---

## 第一部分：变量与类型

### 题 1：可变默认参数

```python
def add_item(item, lst=[]):
    lst.append(item)
    return lst

print(add_item(1))    # ?
print(add_item(2))    # ?
print(add_item(3))    # ?
```

**答案**：`[1]`、`[1, 2]`、`[1, 2, 3]`
**原因**：默认参数在函数定义时只求值一次，所有调用共享同一个 list 对象。修复：用 `lst=None`。

---

### 题 2：is 和 ==

```python
a = 256
b = 256
print(a is b)     # ?

c = 257
d = 257
print(c is d)     # ?

e = "hello"
f = "hello"
print(e is f)     # ?
```

**答案**：`True`、`True`（脚本中，因编译优化）或 `False`（交互式中）、`True`（字符串驻留）
**原因**：CPython 缓存 [-5, 256] 的小整数。字符串驻留（interning）对纯字母数字字符串生效。⚠️ 永远不要依赖 `is` 比较值！

---

### 题 3：列表乘法陷阱

```python
grid = [[0] * 3] * 3
grid[0][0] = 1
print(grid)    # ?
```

**答案**：`[[1, 0, 0], [1, 0, 0], [1, 0, 0]]`
**原因**：`[[0]*3] * 3` 复制的是引用，三行是同一个列表。修复：`[[0]*3 for _ in range(3)]`。

---

### 题 4：字符串是不可变的

```python
s = "hello"
s[0] = "H"      # ?
```

**答案**：`TypeError: 'str' does not support item assignment`
**原因**：str 是不可变类型。要修改需要创建新字符串：`s = "H" + s[1:]`。

---

## 第二部分：函数与作用域

### 题 5：闭包变量捕获

```python
funcs = [lambda x: x + i for i in range(4)]
print([f(0) for f in funcs])    # ?
```

**答案**：`[3, 3, 3, 3]`
**原因**：lambda 捕获的是变量 `i` 的引用，循环结束后 `i == 3`。修复：`lambda x, i=i: x + i`。

---

### 题 6：LEGB 作用域

```python
x = 10
def func():
    print(x)
    x = 20

func()   # ?
```

**答案**：`UnboundLocalError: local variable 'x' referenced before assignment`
**原因**：Python 在编译时看到 `x = 20`，就把整个函数中的 `x` 视为局部变量。`print(x)` 时局部 `x` 还没赋值。

---

### 题 7：可变参数传递

```python
def modify(lst):
    lst.append(4)
    lst = [10, 20]   # 重新绑定，不影响外部

a = [1, 2, 3]
modify(a)
print(a)    # ?
```

**答案**：`[1, 2, 3, 4]`
**原因**：`lst.append(4)` 修改了原对象。`lst = [10, 20]` 只是让局部名字 `lst` 指向新对象，不影响外部的 `a`。

---

### 题 8：*args 解包

```python
def func(a, b, c):
    print(a, b, c)

t = (1, 2, 3)
func(*t)      # ?
func(t)       # ?
```

**答案**：第一个输出 `1 2 3`。第二个报 `TypeError: func() missing 2 required positional arguments`。
**原因**：`*t` 解包元组为三个参数，`t` 本身是一个参数。

---

## 第三部分：类与对象

### 题 9：类变量 vs 实例变量

```python
class Dog:
    tricks = []

    def add_trick(self, trick):
        self.tricks.append(trick)

d1 = Dog()
d2 = Dog()
d1.add_trick("roll")
print(d2.tricks)    # ?
```

**答案**：`['roll']`
**原因**：`tricks` 是类变量，所有实例共享同一个列表。修复：在 `__init__` 中初始化为实例变量。

---

### 题 10：MRO 继承顺序

```python
class A:
    def who(self):
        print("A", end=" ")

class B(A):
    def who(self):
        print("B", end=" ")
        super().who()

class C(A):
    def who(self):
        print("C", end=" ")
        super().who()

class D(B, C):
    def who(self):
        print("D", end=" ")
        super().who()

D().who()    # ?
```

**答案**：`D B C A`
**原因**：MRO = [D, B, C, A, object]。`super()` 按 MRO 顺序调用，每个类只调用一次。

---

### 题 11：`__init__` 返回值

```python
class Foo:
    def __init__(self):
        return 42

f = Foo()   # ?
```

**答案**：`TypeError: __init__() should return None`
**原因**：`__init__` 只能返回 `None`。实例创建由 `__new__` 负责。

---

## 第四部分：迭代与生成器

### 题 12：生成器只能遍历一次

```python
gen = (x for x in range(3))
print(list(gen))    # ?
print(list(gen))    # ?
```

**答案**：`[0, 1, 2]`、`[]`
**原因**：生成器是一次性迭代器，耗尽后不会重置。

---

### 题 13：字典遍历时修改

```python
d = {"a": 1, "b": 2, "c": 3}
for k in d:
    if d[k] == 2:
        del d[k]     # ?
```

**答案**：`RuntimeError: dictionary changed size during iteration`
**原因**：不能在遍历字典时修改其大小。修复：`d = {k: v for k, v in d.items() if v != 2}`。

---

### 题 14：range 不是列表

```python
print(type(range(10)))        # ?
print(range(10) == range(10)) # ?
print(range(10) is range(10)) # ?
```

**答案**：`<class 'range'>`、`True`（Python 3.3+）、`False`
**原因**：`range` 是惰性序列对象，不是列表。Python 3.3+ 实现了 `__eq__` 按值比较。

---

## 第五部分：特殊行为

### 题 15：链式比较

```python
print(1 < 2 < 3)       # ?
print(1 < 2 > 0)       # ?
print(True == 1 == 1.0) # ?
print((True == 1) == 1.0) # ?
```

**答案**：`True`、`True`、`True`、`True`
**原因**：链式比较 `a < b < c` 等价于 `a < b and b < c`。`True == 1` 因为 `bool` 是 `int` 的子类。

---

### 题 16：try-finally 中的 return

```python
def func():
    try:
        return 1
    finally:
        return 2

print(func())   # ?
```

**答案**：`2`
**原因**：`finally` 块总是执行，且其中的 `return` 会覆盖 `try` 中的 `return`。

---

### 题 17：or 和 and 的返回值

```python
print(0 or 1)       # ?
print(1 or 2)       # ?
print(0 and 1)      # ?
print(1 and 2)      # ?
print("" or "hi")   # ?
print(None or [])    # ?
```

**答案**：`1`、`1`、`0`、`2`、`"hi"`、`[]`
**原因**：`or` 返回第一个真值或最后一个值；`and` 返回第一个假值或最后一个值。

---

### 题 18：`+= ` 对元组的怪异行为

```python
t = (1, 2, [3, 4])
t[2] += [5, 6]     # ?
print(t)            # ?
```

**答案**：抛出 `TypeError`，但 `t` 变成了 `(1, 2, [3, 4, 5, 6])`！
**原因**：`+=` 先执行 `t[2].__iadd__([5, 6])`（成功修改了列表），然后执行 `t[2] = result`（失败，元组不可变）。列表已被修改，但赋值回元组失败。

---

### 题 19：浮点精度

```python
print(0.1 + 0.2 == 0.3)              # ?
print(round(0.1 + 0.2, 1) == 0.3)    # ?
print(0.1 + 0.1 + 0.1 == 0.3)        # ?
print(0.1 + 0.1 + 0.1 - 0.3)        # ?
```

**答案**：`False`、`True`、`False`、`5.551115123125783e-17`
**原因**：IEEE 754 浮点数的精度问题。精确计算用 `decimal.Decimal`。

---

### 题 20：空列表的真值

```python
print([] == False)    # ?
print(bool([]) == False)  # ?
if []:
    print("True")
else:
    print("False")    # ?
```

**答案**：`False`、`True`、`False`
**原因**：`[] == False` 是值比较（list 和 bool 不相等）；`bool([])` 是 `False`；`if []` 检查真值。

---

## 第六部分：综合题

### 题 21：一行代码交换字典的 key 和 value

```python
d = {"a": 1, "b": 2, "c": 3}
# 答案：
flipped = {v: k for k, v in d.items()}
```

### 题 22：一行代码展平嵌套列表

```python
nested = [[1, 2], [3, 4], [5, 6]]
# 答案：
flat = [x for sub in nested for x in sub]
```

### 题 23：用 collections.Counter 找 top-k

```python
from collections import Counter
words = ["apple", "banana", "apple", "cherry", "apple", "banana"]
# 答案：
top2 = Counter(words).most_common(2)  # [('apple', 3), ('banana', 2)]
```

---

## 面试应答技巧

1. **先说结论**，再解释原因
2. **提到底层机制**：引用计数、MRO、字节码、GIL
3. **说修复方案**：不只是发现问题，还要能修
4. **区分版本差异**：3.6 dict 有序、3.8 海象运算符、3.10 match-case
5. **关联实际场景**：这个陷阱在实际项目中会导致什么 bug
