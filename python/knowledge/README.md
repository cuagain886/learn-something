# Python 进阶 & 大厂面试知识点深入文档

> 适用对象：已掌握 Python 基础语法（见 code/ 目录 01–20 教程），想深入**底层原理**、应对**大厂面试**的同学。
>
> 每篇文档结构统一：**原理讲解 → 底层结构剖析 → 代码示例 → 高频面试题 + 标准答案 → 一句话总结**。
> 标 ⭐ 的是面试出现频率最高的考点，标 ⚠️ 的是最容易答错/写错的陷阱。

---

## 📚 章节索引

### 第一部分：对象模型与数据结构底层（面试必考 ⭐⭐⭐）

| # | 文档 | 核心考点 |
|---|------|---------|
| 01 | [对象模型](01_object_model.md) | ⭐ 一切皆对象、id/type/value、名字绑定、可变/不可变、type 与 object 的关系 |
| 02 | [dict 底层原理](02_dict_internals.md) | ⭐ 紧凑哈希表、开放寻址、3.7+ 保序、扩容机制、可哈希要求 |

### 第二部分：解释器与内存（大厂区分度高 ⭐⭐⭐）

| # | 文档 | 核心考点 |
|---|------|---------|
| 03 | [GIL 全局解释器锁](03_gil.md) | ⭐⭐ GIL 是什么、为什么存在、何时释放、I/O vs CPU 场景、绕过方案、free-threaded Python |
| 04 | [描述符协议](04_descriptor_protocol.md) | ⭐ 数据/非数据描述符、属性查找优先级、property 原理、方法绑定原理 |
| 05 | [元类 Metaclass](05_metaclass.md) | ⭐ type 创建类、自定义元类、`__init_subclass__` 替代方案 |
| 06 | [内存管理与 GC](06_memory_gc.md) | ⭐⭐ 引用计数、循环引用、分代 GC、pymalloc 内存池、弱引用 |

### 第三部分：高级特性与并发（高频 ⭐⭐）

| # | 文档 | 核心考点 |
|---|------|---------|
| 07 | [生成器与协程](07_generator_coroutine.md) | ⭐ yield 挂起栈帧、yield from、async/await、事件循环、异步迭代 |
| 08 | [导入系统](08_import_system.md) | ⭐ finder/loader、sys.path、sys.modules 缓存、循环导入、相对导入 |
| 09 | [并发编程](09_concurrency.md) | ⭐⭐ threading/multiprocessing/asyncio 三模型对比、线程同步、concurrent.futures |
| 10 | [装饰器与闭包深入](10_decorators_closures.md) | ⭐ 闭包 cell 对象、自由变量、functools.wraps、装饰器模板、描述符交互 |

### 第四部分：工程实战（加分项 ⭐）

| # | 文档 | 核心考点 |
|---|------|---------|
| 11 | [性能优化](11_performance.md) | cProfile/timeit、常见反模式、数据结构选择、加速方案（numpy/缓存/多进程/JIT） |
| 12 | [高频面试陷阱题集锦](12_interview_traps.md) | ⚠️ 30+ 道经典手撕题（输出什么？为什么？怎么改）+ 答案解析 |

---

## 🎯 推荐学习路线

```
面试冲刺（2 周）            系统进阶（1 个月）
─────────────            ─────────────
Day 1-2  : 01 02           先把 01-02 吃透（对象模型是地基）
Day 3-4  : 03 06 ⭐重点     再攻 03 06（GIL 和内存，最能体现深度）
Day 5-6  : 04 05           然后 04 05（描述符/元类，理解 Python 魔法）
Day 7-9  : 07 09 ⭐重点     然后 07 08 09（并发三件套）
Day 10-11: 08 10           最后 10 11 12（装饰器/性能/刷题）
Day 12-14: 11 12 刷题       ★ 每篇末尾的面试题都要能脱口而出
```

**面试官最爱问的 5 个"灵魂拷问"**（在对应文档里都有详解）：

1. **GIL 是什么？多线程能利用多核吗？怎么绕过？** → [03](03_gil.md)
2. **Python 的垃圾回收机制？引用计数的局限性？** → [06](06_memory_gc.md)
3. **解释 Python 的对象模型——变量、赋值、参数传递的本质？** → [01](01_object_model.md)
4. **dict 为什么有序？底层是怎么实现的？** → [02](02_dict_internals.md)
5. **asyncio 和多线程的区别？什么场景用哪个？** → [09](09_concurrency.md)

---

## 🛠️ 配套工具命令（边学边用）

```bash
# 性能分析
python -m cProfile -s cumulative script.py    # 函数级耗时分析
python -m timeit "sum(range(1000))"           # 微基准测试

# 内存分析
python -m memory_profiler script.py           # 行级内存分析（需安装）

# 类型检查
mypy --strict script.py                       # 静态类型检查

# 字节码查看
python -m dis script.py                       # 反汇编 Python 字节码

# 对象检查
python -c "import sys; print(sys.getsizeof(42))"    # 对象内存大小
python -c "import gc; gc.set_debug(gc.DEBUG_STATS)"  # GC 调试信息

# 交互式调试
python -i script.py                           # 运行后进入交互模式
python -m pdb script.py                       # 启动调试器
```

---

## ⚠️ 关于版本

本文档基于 **Python 3.10+**。涉及版本差异的地方会特别标注，常见的几个分水岭：

- **Python 3.5**：类型提示（typing 模块）、`async/await` 原生语法
- **Python 3.6**：f-string、`__init_subclass__`、dict 保序（CPython 实现细节）
- **Python 3.7**：dataclass、dict 保序成为语言规范、`asyncio.run()`
- **Python 3.8**：海象运算符 `:=`、仅限位置参数 `/`、`typing.Final`
- **Python 3.9**：内置泛型 `list[int]`（不再需要 `from typing import List`）
- **Python 3.10**：match-case 模式匹配、`X | Y` 联合类型语法
- **Python 3.11**：ExceptionGroup、TaskGroup、显著性能提升（10-60%）
- **Python 3.12**：改进的错误信息、f-string 嵌套引号、类型参数语法
- **Python 3.13**：实验性 free-threaded 模式（无 GIL）

> 面试时如果被问到"你用的哪个版本，有什么新特性"，上面这些是加分项。
