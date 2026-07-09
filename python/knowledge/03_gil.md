# 03 · GIL 全局解释器锁 ⭐⭐⭐

> GIL 是 Python 面试出现频率最高的底层问题：
> **GIL 是 CPython 的互斥锁，使得任一时刻只有一个线程执行 Python 字节码。**

---

## 1. 什么是 GIL？

GIL（Global Interpreter Lock）是 CPython 解释器中的一把全局互斥锁。

```
多线程执行示意（有 GIL）：

Thread 1: ████░░░░████░░░░████
Thread 2: ░░░░████░░░░████░░░░
          ──────────────────────→ 时间
          
          █ = 持有 GIL，执行字节码
          ░ = 等待 GIL
```

任一时刻只有一个线程能持有 GIL 执行 Python 字节码，其他线程被阻塞。

---

## 2. 为什么存在 GIL？

1. **引用计数安全**：CPython 用引用计数管理内存。没有 GIL，多线程同时修改引用计数会导致竞态条件（内存泄漏或提前释放）
2. **历史原因**：Python 1.5 时代（1997 年），多核 CPU 不普及，GIL 是最简单的线程安全方案
3. **C 扩展兼容**：大量 C 扩展假设 GIL 存在，去掉 GIL 会破坏兼容性
4. **单线程性能**：有 GIL 的单线程比细粒度锁的单线程更快

---

## 3. GIL 的释放时机

GIL 不是"绝对锁死"，在以下情况会释放：

```python
# 1. I/O 操作时释放（文件、网络、数据库...）
data = file.read()      # I/O 期间释放 GIL，其他线程可以执行

# 2. 调用 C 扩展时可选释放（numpy、PIL 等主动释放）
import numpy as np
result = np.dot(a, b)   # numpy 在 C 层面释放 GIL

# 3. 定期释放（每执行 N 条字节码或超时后强制切换）
#    Python 3.2+：默认每 5ms 切换一次（sys.getswitchinterval()）
import sys
print(sys.getswitchinterval())  # 0.005 (5ms)
```

---

## 4. GIL 对不同场景的影响

### CPU 密集型：GIL 是瓶颈

```python
import threading, time

def cpu_bound():
    total = 0
    for i in range(10_000_000):
        total += i

# 单线程
start = time.time()
cpu_bound()
cpu_bound()
print(f"单线程: {time.time() - start:.2f}s")

# 多线程（⚠️ 不会更快，可能更慢！）
start = time.time()
t1 = threading.Thread(target=cpu_bound)
t2 = threading.Thread(target=cpu_bound)
t1.start(); t2.start()
t1.join(); t2.join()
print(f"多线程: {time.time() - start:.2f}s")  # 差不多甚至更慢
```

### I/O 密集型：GIL 不是瓶颈

```python
import threading, time, urllib.request

def io_bound(url):
    urllib.request.urlopen(url).read()

# 多线程处理 I/O 是有效的（GIL 在 I/O 等待时释放）
urls = ["https://example.com"] * 10
threads = [threading.Thread(target=io_bound, args=(url,)) for url in urls]
# 10 个线程并发请求，总时间接近 1 次请求的时间
```

### 总结

| 场景 | GIL 影响 | 推荐方案 |
|------|---------|---------|
| I/O 密集 | 几乎无影响 | `threading` / `asyncio` |
| CPU 密集 | 严重瓶颈 | `multiprocessing` / C 扩展 |
| 混合型 | 部分影响 | 视比例选择 |

---

## 5. 绕过 GIL 的方案

### 方案 1：multiprocessing（多进程）

```python
from multiprocessing import Pool

def cpu_bound(n):
    return sum(range(n))

with Pool(4) as pool:              # 4 个进程，各有独立的 GIL
    results = pool.map(cpu_bound, [10**7] * 4)
```

### 方案 2：C 扩展主动释放 GIL

```c
// C 扩展中用 Py_BEGIN_ALLOW_THREADS 释放 GIL
Py_BEGIN_ALLOW_THREADS
// ... 纯 C 计算，不操作 Python 对象 ...
Py_END_ALLOW_THREADS
```

numpy、Pillow、OpenCV 等库都这样做。

### 方案 3：asyncio（协程，I/O 密集型）

```python
import asyncio, aiohttp

async def fetch(url):
    async with aiohttp.ClientSession() as session:
        async with session.get(url) as resp:
            return await resp.text()
```

### 方案 4：free-threaded Python（Python 3.13+）

Python 3.13 实验性支持 `--disable-gil` 编译选项（PEP 703），3.14+ 逐步稳定化：

```bash
# 编译无 GIL 的 Python
./configure --disable-gil
make

# 或使用支持 free-threading 的发行版
python3.13t  # "t" 后缀表示 free-threaded 构建
```

⚠️ 目前仍是实验性的，很多 C 扩展尚未适配。

---

## 6. 与 Go 的对比

| 特性 | Python (CPython) | Go |
|------|-----------------|-----|
| 并发模型 | 线程 + GIL | goroutine + 调度器 |
| CPU 并行 | 需要多进程 | goroutine 原生并行 |
| I/O 并发 | threading/asyncio | goroutine 自动调度 |
| 内存管理 | 引用计数 + 循环 GC | 三色标记 GC |
| GIL 等价物 | GIL | 无（细粒度锁） |

---

## 高频面试题

**Q1：什么是 GIL？它解决什么问题？**
A：GIL 是 CPython 的全局互斥锁，保护引用计数的线程安全。它使得任一时刻只有一个线程执行 Python 字节码。

**Q2：GIL 意味着 Python 多线程完全没用吗？**
A：不是。I/O 密集型任务中多线程仍然有效，因为 GIL 在 I/O 等待时会释放。只有 CPU 密集型任务受 GIL 限制。

**Q3：如何实现 Python 的 CPU 并行？**
A：1) `multiprocessing`（多进程，各有独立 GIL）；2) C 扩展释放 GIL（如 numpy）；3) Python 3.13+ 的 free-threaded 模式。

**Q4：asyncio 能绕过 GIL 吗？**
A：不能。asyncio 是单线程的协程方案，根本不涉及 GIL。它通过协作式切换在一个线程上高效处理大量 I/O 任务，但不提供 CPU 并行。

---

## 一句话总结

GIL 让 CPython 多线程无法并行执行 Python 字节码；I/O 密集型用 threading/asyncio 没问题，CPU 密集型必须用 multiprocessing 或 C 扩展绕过 GIL。
