# 01 · Python 对象模型 ⭐⭐⭐

> 理解 Python 的第一步就是理解这句话：
> **Python 中一切皆对象——整数是对象、函数是对象、类本身也是对象。**

---

## 1. 对象的三要素：id、type、value

Python 中每个对象都有三个基本属性：

```python
x = 42
print(id(x))     # 身份标识（内存地址），整个生命周期不变
print(type(x))   # 类型：<class 'int'>
print(x)         # 值：42
```

- **id**：`id()` 返回对象的唯一标识（CPython 中就是内存地址）。`is` 运算符比较的就是 id
- **type**：`type()` 返回对象的类型。类型本身也是对象（`type(int)` 是 `<class 'type'>`）
- **value**：对象的值。不可变对象的值创建后不能改变

### 面试要点

```python
a = [1, 2, 3]
b = a          # b 和 a 是同一个对象（id 相同）
c = [1, 2, 3]  # c 是另一个对象（id 不同，但值相等）

a == c   # True（值相等）
a is c   # False（不是同一个对象）
a is b   # True（同一个对象）
```

⚠️ **永远不要用 `is` 比较值**（除了 `None`）。小整数缓存（-5 到 256）和字符串驻留会让 `is` 在某些值上"碰巧"返回 True，但这是实现细节，不可依赖。

---

## 2. 变量是标签，不是盒子

Python 的变量模型和 C/Go 完全不同：

```
C/Go 模型（盒子）：          Python 模型（标签）：
┌─────┐                    ┌─────┐
│  42 │ <- 变量 x           │  42 │ <- 对象（在堆上）
└─────┘                    └─────┘
                              ↑  ↑
                              x  y   <- 名字（标签）
```

赋值 `x = 42` 的含义是：**让名字 `x` 绑定（引用）到值为 42 的 int 对象**。

```python
x = 42
y = x    # y 也指向同一个 int 对象
x = 99   # x 重新绑定到新对象，y 不受影响
```

**面试要点**：解释"Python 是传值还是传引用"？
答：都不是。Python 是 **pass by object reference**（传对象引用）：
- 函数收到的是对象引用的副本（和 Java 一样）
- 对可变对象的原地修改会影响调用者
- 重新赋值（重新绑定）不影响调用者

---

## 3. 可变与不可变

| 不可变（immutable） | 可变（mutable） |
|---|---|
| int, float, bool, str, tuple, frozenset, bytes | list, dict, set, bytearray |

### 不可变的深层含义

```python
x = "hello"
x += " world"   # 创建了新字符串对象，x 重新绑定
```

不可变对象一旦创建，其内容（value）就不能改变。任何"修改"操作实际上都是创建了新对象。

### 可变对象的陷阱

```python
# 陷阱 1：函数默认参数
def append_to(item, lst=[]):  # ⚠️ 所有调用共享同一个 list！
    lst.append(item)
    return lst

# 陷阱 2：列表乘法
grid = [[0] * 3] * 3   # ⚠️ 3 行是同一个 list 的 3 个引用
grid[0][0] = 1          # 三行都变了！

# 陷阱 3：字典/集合的 key 必须是不可变的（可哈希的）
d = {[1, 2]: "value"}   # TypeError! list 不可哈希
```

---

## 4. 类型层次：type 与 object 的关系

Python 类型系统的核心关系：

```
object  <──── 所有类的基类（万物之祖）
  ↑
type    <──── 所有类的元类（创建类的类）
  ↑
int     <──── 普通类型
```

```python
isinstance(42, int)      # True：42 是 int 的实例
isinstance(42, object)   # True：42 也是 object 的实例
isinstance(int, type)    # True：int 类是 type 的实例
isinstance(type, object) # True：type 也是 object 的实例
issubclass(int, object)  # True：int 继承自 object
issubclass(type, object) # True：type 继承自 object

# ⚠️ 鸡生蛋问题：
isinstance(object, type)  # True：object 是 type 的实例
isinstance(type, type)    # True：type 是自身的实例！（CPython 启动时特殊处理）
```

**面试要点**：`type` 和 `object` 的关系是 Python 元编程的基石。所有类都是 `type` 的实例（包括 `type` 自身），所有类都继承自 `object`（包括 `type`）。

---

## 5. 属性查找顺序（MRO + 描述符协议）

当你写 `obj.attr` 时，Python 的查找顺序：

1. **数据描述符**（类及其 MRO 链上的，同时定义了 `__get__` 和 `__set__`）
2. **实例的 `__dict__`**
3. **非数据描述符**（类及其 MRO 链上的，只定义了 `__get__`）

```python
class MyClass:
    class_attr = "class"

    def __init__(self):
        self.instance_attr = "instance"

obj = MyClass()
obj.attr        # 先查 obj.__dict__，再查 MyClass.__dict__，再查基类
```

---

## 高频面试题

**Q1：Python 中 `==` 和 `is` 的区别？**
A：`==` 比较值（调用 `__eq__`），`is` 比较身份（id 是否相同）。只有比较 `None` 时用 `is`。

**Q2：为什么 Python 的整数没有溢出？**
A：CPython 的 int 是任意精度整数，内部用数组存储多个"数字单元"（digit），自动扩展。

**Q3：`a = [1]; b = a; b.append(2); print(a)` 输出什么？为什么？**
A：`[1, 2]`。因为 a 和 b 绑定到同一个列表对象，通过 b 修改列表，a 也能看到。

**Q4：元组是不可变的，但 `t = ([1,2],); t[0].append(3)` 为什么不报错？**
A：元组不可变指的是元组的元素引用不可改变（不能让 `t[0]` 指向别的对象），但被引用的列表对象本身是可变的。

---

## 一句话总结

Python 的变量是"名字贴在对象上"，不是"盒子装数据"；理解 id/type/value 三要素和可变/不可变的区别，是避开 90% Python 陷阱的关键。
