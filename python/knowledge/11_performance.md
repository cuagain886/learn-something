# 11 · 性能优化 ⭐⭐

> Python 以开发效率见长，但运行速度不是它的强项。理解瓶颈在哪、知道怎么度量、掌握常见优化手段，是高级 Python 开发者的必修课。

---

## 1. 性能分析工具

### timeit：微基准测试

```python
import timeit

# 命令行
# python -m timeit "sum(range(1000))"

# 代码中
t = timeit.timeit("sum(range(1000))", number=10000)
print(f"{t:.4f}s for 10000 iterations")

# 比较两种实现
t1 = timeit.timeit("[x**2 for x in range(1000)]", number=1000)
t2 = timeit.timeit("list(map(lambda x: x**2, range(1000)))", number=1000)
print(f"推导式: {t1:.4f}s, map: {t2:.4f}s")
```

### cProfile：函数级分析

```python
import cProfile

def slow_function():
    total = 0
    for i in range(100000):
        total += i ** 2
    return total

cProfile.run("slow_function()")

# 命令行
# python -m cProfile -s cumulative myscript.py

# 输出列含义：
# ncalls: 调用次数
# tottime: 函数自身耗时（不含子调用）
# cumtime: 累计耗时（含子调用）
# percall: 每次调用平均耗时
```

### line_profiler：行级分析

```python
# pip install line_profiler
# kernprof -l -v myscript.py

@profile   # line_profiler 提供的装饰器
def compute():
    data = [i ** 2 for i in range(10000)]
    result = sum(data)
    return result
```

### memory_profiler：内存分析

```python
# pip install memory_profiler
# python -m memory_profiler myscript.py

@profile
def memory_heavy():
    a = [i for i in range(1000000)]
    del a
```

---

## 2. 常见性能反模式

### 反模式 1：字符串拼接

```python
# ⚠️ 慢：O(n²)，每次 + 创建新字符串
result = ""
for i in range(10000):
    result += str(i)

# ✓ 快：O(n)
result = "".join(str(i) for i in range(10000))
```

### 反模式 2：列表中查找

```python
# ⚠️ 慢：O(n) 查找
if item in large_list:
    ...

# ✓ 快：O(1) 查找
large_set = set(large_list)
if item in large_set:
    ...
```

### 反模式 3：全局变量访问

```python
# ⚠️ 慢：全局变量查找需要查 global dict
MY_LIST = list(range(100))
def slow():
    for _ in range(1000000):
        len(MY_LIST)   # 每次查 global -> builtin

# ✓ 快：局部变量直接索引
def fast():
    local_list = MY_LIST  # 局部引用
    local_len = len
    for _ in range(1000000):
        local_len(local_list)
```

### 反模式 4：不用内置函数

```python
# ⚠️ 慢：纯 Python 循环
total = 0
for x in data:
    total += x

# ✓ 快：内置函数（C 实现）
total = sum(data)

# 同理：min(), max(), sorted(), any(), all() 都比手写循环快
```

### 反模式 5：过度使用异常

```python
# ⚠️ 频繁抛出异常有性能开销
for key in keys:
    try:
        value = d[key]
    except KeyError:
        value = default

# ✓ 更快
for key in keys:
    value = d.get(key, default)
```

---

## 3. 数据结构选择

| 操作 | list | dict/set | deque |
|------|------|----------|-------|
| 索引访问 | O(1) | O(1) | O(n) |
| 头部插入 | O(n) | - | O(1) |
| 尾部插入 | O(1)* | O(1) | O(1) |
| 成员测试 | O(n) | O(1) | O(n) |
| 排序 | O(n log n) | - | - |

```python
from collections import deque

# 需要频繁在两端操作 → deque
d = deque(maxlen=1000)   # 固定大小的环形缓冲区

# 需要频繁查找 → set/dict
seen = set()
```

---

## 4. 加速方案

### 方案 1：算法优化（最重要！）

```python
# O(n²) → O(n log n) 的提升远大于任何语言级优化
```

### 方案 2：使用 C 扩展库

```python
# numpy 向量化计算
import numpy as np
a = np.arange(1000000)
result = np.sum(a ** 2)   # 比纯 Python 快 100 倍
```

### 方案 3：functools.lru_cache

```python
from functools import lru_cache

@lru_cache(maxsize=None)
def fibonacci(n):
    if n < 2:
        return n
    return fibonacci(n-1) + fibonacci(n-2)
```

### 方案 4：`__slots__` 减少内存

```python
class Point:
    __slots__ = ('x', 'y')
    def __init__(self, x, y):
        self.x = x
        self.y = y
# 比普通类省 40-50% 内存，属性访问也更快
```

### 方案 5：多进程并行

```python
from concurrent.futures import ProcessPoolExecutor

with ProcessPoolExecutor() as executor:
    results = list(executor.map(cpu_heavy_func, data))
```

### 方案 6：Cython / PyPy / Numba

```python
# Numba JIT 编译
from numba import jit

@jit(nopython=True)
def fast_sum(n):
    total = 0
    for i in range(n):
        total += i * i
    return total
```

---

## 5. 与 Go 的性能对比

| 维度 | Python | Go |
|------|--------|-----|
| 原生速度 | 慢（解释型） | 快（编译型） |
| 典型差距 | 10-100x | 基准 |
| 加速手段 | C 扩展/numpy/Cython | 本身就快 |
| 启动时间 | 慢（导入开销） | 快（静态二进制） |
| 内存占用 | 高（对象开销大） | 低（值类型） |
| 开发速度 | 快 | 中等 |

---

## 高频面试题

**Q1：Python 为什么慢？**
A：1) 解释执行（每条指令都有解释器开销）；2) 动态类型（每次操作都要检查类型）；3) GIL 限制多线程并行；4) 对象模型开销（int 42 在 CPython 中占 28 字节）。

**Q2：如何优化 Python 性能？**
A：1) 算法优化（最优先）；2) 用内置函数和数据结构；3) 向量化计算（numpy）；4) 缓存（lru_cache）；5) 多进程并行；6) C 扩展或 JIT（Cython/Numba）。

**Q3：列表推导式为什么比 for 循环快？**
A：推导式在字节码层面有优化（直接用 LIST_APPEND 指令），避免了 for 循环中每次调用 `list.append()` 的属性查找和函数调用开销。

---

## 一句话总结

Python 性能优化的优先级：算法 > 数据结构 > 内置函数 > C 扩展/向量化 > 多进程；先用 cProfile 找到瓶颈，再针对性优化。
