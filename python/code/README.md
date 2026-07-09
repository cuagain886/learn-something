# Python 语言系统学习教程

为有其他语言经验的程序员准备的 Python 入门到进阶教程。每个编号目录是一个**可独立运行**的主题，代码中的中文注释就是教材——**建议边读注释边运行，再动手改代码做实验**。

## 环境与运行方式

```powershell
python --version                  # 确认已安装（本教程基于 Python 3.10+）

# 在本目录（code/）下运行任意主题：
python 01_hello/main.py           # 运行第 1 课
python 09_comprehensions/main.py  # 运行第 9 课

# 特殊几课：
cd 18_modules_packages && python main.py  # 第 18 课需在其目录下运行
cd 20_testing && python -m pytest test_mathx.py -v  # 第 20 课用 pytest 运行
```

## 学习顺序

按编号顺序学即可，每课约 30–60 分钟（读注释 + 运行 + 自己改代码实验）。

### 第一阶段：基础语法（01–09）

| # | 主题 | 核心知识点 |
|---|------|-----------|
| 01 | [程序结构](01_hello/main.py) | import、`if __name__`、print、注释、_ 命名约定 |
| 02 | [变量与类型](02_variables/main.py) | 动态类型、名字绑定、零值、可变/不可变、类型转换 |
| 03 | [运算符与格式化](03_operators_fmt/main.py) | `//` 整除、`**` 幂、链式比较、f-string、海象 `:=` |
| 04 | [流程控制](04_flow_control/main.py) | if/elif、for-in、range、while、for-else、match-case |
| 05 | [函数](05_functions/main.py) | 默认参数、`*args/**kwargs`、闭包、⚠️可变默认值陷阱 |
| 06 | [列表与元组](06_lists_tuples/main.py) | 切片、负索引、append/sort、⚠️浅拷贝、NamedTuple |
| 07 | [字典与集合](07_dicts_sets/main.py) | get/setdefault、Counter、defaultdict、集合运算 |
| 08 | [字符串](08_strings/main.py) | 不可变、encode/decode、正则 re、StringIO |
| 09 | [推导式](09_comprehensions/main.py) | 列表/字典/集合推导式、生成器表达式、性能对比 |

### 第二阶段：面向对象（10–14）

| # | 主题 | 核心知识点 |
|---|------|-----------|
| 10 | [类与对象](10_classes/main.py) | `__init__`、实例/类属性、property、dataclass、`__slots__` |
| 11 | [继承与多态](11_inheritance/main.py) | super()、多继承、MRO（C3 线性化）、ABC、鸭子类型、Protocol |
| 12 | [魔术方法](12_magic_methods/main.py) | `__str__/__repr__`、运算符重载、容器协议、`__call__` |
| 13 | [异常处理](13_exceptions/main.py) | try/except/else/finally、自定义异常、异常链、EAFP |
| 14 | [类型提示](14_type_hints/main.py) | Optional、Union、TypeVar、Generic、Protocol、mypy |

### 第三阶段：高级特性（15–17）—— Python 的灵魂

| # | 主题 | 核心知识点 |
|---|------|-----------|
| 15 | [迭代器与生成器](15_iterators_generators/main.py) | 迭代协议、yield、yield from、send、itertools |
| 16 | [装饰器](16_decorators/main.py) | 函数装饰器、带参装饰器、类装饰器、functools.wraps/lru_cache |
| 17 | [上下文管理器](17_context_managers/main.py) | with、`__enter__/__exit__`、contextlib、ExitStack |

### 第四阶段：工程化（18–20）

| # | 主题 | 核心知识点 |
|---|------|-----------|
| 18 | [模块与包](18_modules_packages/main.py) | module vs package、`__init__.py`、`__all__`、venv/pip（见 [myutils 子包](18_modules_packages/myutils/)） |
| 19 | [标准库速览](19_stdlib/main.py) | datetime、pathlib、JSON 序列化、HTTP 服务端/客户端 |
| 20 | [测试](20_testing/test_mathx.py) | unittest、pytest、参数化测试、fixture、Mock |

## 怎么学效果最好

1. **先跑再读**：`python main.py` 看输出，对照源码注释理解每一行
2. **动手破坏**：把注释里标 ⚠️ 的陷阱代码取消注释，亲眼看它怎么坏
3. **自己重写**：合上教程，凭记忆重写本课的核心示例
4. **交互实验**：`python -i main.py` 运行后进入交互模式，随意实验

## 学完之后

- **官方教程**：<https://docs.python.org/3/tutorial/>（官方入门）
- **Python Cookbook**：实战菜谱，进阶必读
- **Fluent Python**：深入 Python 的"Pythonic"写法和底层原理
- **Real Python**：<https://realpython.com>（高质量教程网站）
- **练手项目建议**：CLI 待办工具（练 argparse/json/pathlib）→ Web API（练 FastAPI/SQLite）→ 数据分析（练 pandas/matplotlib）→ 自动化脚本（练 requests/subprocess）
