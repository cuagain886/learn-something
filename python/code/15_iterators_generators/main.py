"""
═══════════════════════════════════════════════════════════════════

    15_iterators_generators —— 迭代器与生成器

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. 迭代协议：__iter__ 与 __next__
 2. 生成器函数（yield）
 3. yield from：委托生成器
 4. 生成器的高级用法：send、throw、close
 5. itertools 标准库

【运行】python main.py

【与其他语言的对照】
  - Go 1.23 才引入 range-over-func 迭代器，Python 从一开始就以迭代器为核心
  - Python 的 for 循环底层就是迭代器协议
  - 生成器是 Python 的杀手级特性：惰性求值、内存友好、协程基础
  - JavaScript 的 function* 和 Python 的 yield 概念相同
"""
import itertools


# ───────────────────────────────────────────────────────────────
# 1. 迭代器协议
# ───────────────────────────────────────────────────────────────
class CountDown:
    """自定义迭代器：从 n 倒数到 1"""

    def __init__(self, n):
        self.n = n

    def __iter__(self):
        """返回迭代器对象（自身）"""
        return self

    def __next__(self):
        """返回下一个值，耗尽时抛 StopIteration"""
        if self.n <= 0:
            raise StopIteration
        self.n -= 1
        return self.n + 1


def demo_iterator():
    print("══════ 1. 迭代器协议 ══════")

    # for 循环的底层机制：
    # 1. 调用 iter(obj) -> 得到迭代器
    # 2. 反复调用 next(iterator) -> 得到下一个值
    # 3. 捕获 StopIteration -> 结束循环

    for n in CountDown(5):
        print(n, end=" ")
    print()

    # 手动使用迭代器
    it = iter([10, 20, 30])
    print(f"next: {next(it)}")   # 10
    print(f"next: {next(it)}")   # 20
    print(f"next: {next(it)}")   # 30
    # next(it)  # ⚠️ StopIteration

    # next 的默认值
    it2 = iter([])
    print(f"next with default: {next(it2, '空了')}")

    # ⭐ 可迭代（iterable）vs 迭代器（iterator）
    # - iterable：有 __iter__ 方法的对象（list、dict、str...）
    # - iterator：有 __next__ 方法的对象，且 __iter__ 返回自身
    # - 每次 for 都从 iterable 获取新的 iterator
    lst = [1, 2, 3]
    print(f"list 是 iterable: {hasattr(lst, '__iter__')}")
    print(f"list 是 iterator: {hasattr(lst, '__next__')}")


# ───────────────────────────────────────────────────────────────
# 2. 生成器函数（yield）
# ───────────────────────────────────────────────────────────────
def fibonacci():
    """生成器函数：yield 使函数变成惰性迭代器"""
    a, b = 0, 1
    while True:    # 无限序列！但因为惰性，不会爆内存
        yield a    # 暂停执行，返回 a，等待 next() 恢复
        a, b = b, a + b


def read_large_file(filename):
    """生成器的经典应用：逐行读取大文件，不一次性加载到内存"""
    with open(filename) as f:
        for line in f:
            yield line.strip()


def demo_generator():
    print("\n══════ 2. 生成器函数 ══════")

    # 生成器函数：函数体中有 yield 关键字
    # 调用时不执行函数体，而是返回一个生成器对象（迭代器）
    gen = fibonacci()
    print(f"类型: {type(gen)}")

    # 获取前 10 个斐波那契数
    fib10 = [next(gen) for _ in range(10)]
    print(f"前10个斐波那契: {fib10}")

    # 生成器只能遍历一次
    def simple_gen():
        yield 1
        yield 2
        yield 3

    g = simple_gen()
    print(f"第一次: {list(g)}")   # [1, 2, 3]
    print(f"第二次: {list(g)}")   # [] ⚠️ 空了！

    # ── 生成器 vs 列表的内存对比 ──
    import sys
    list_size = sys.getsizeof([x ** 2 for x in range(10000)])
    gen_size = sys.getsizeof(x ** 2 for x in range(10000))
    print(f"列表内存: {list_size} bytes")
    print(f"生成器内存: {gen_size} bytes")  # 极小，固定大小


# ───────────────────────────────────────────────────────────────
# 3. yield from：委托生成器
# ───────────────────────────────────────────────────────────────
def chain(*iterables):
    """用 yield from 简化嵌套迭代"""
    for it in iterables:
        yield from it    # 等价于 for x in it: yield x


def flatten(nested):
    """递归展平嵌套结构"""
    for item in nested:
        if isinstance(item, (list, tuple)):
            yield from flatten(item)
        else:
            yield item


def demo_yield_from():
    print("\n══════ 3. yield from ══════")

    result = list(chain([1, 2], [3, 4], [5, 6]))
    print(f"chain: {result}")

    nested = [1, [2, 3, [4, 5]], 6, [7, [8, 9]]]
    flat = list(flatten(nested))
    print(f"flatten: {flat}")


# ───────────────────────────────────────────────────────────────
# 4. 生成器的高级用法
# ───────────────────────────────────────────────────────────────
def accumulator():
    """生成器可以接收外部发送的值（协程基础）"""
    total = 0
    while True:
        value = yield total   # yield 表达式的值是 send() 传入的参数
        if value is None:
            break
        total += value


def demo_advanced():
    print("\n══════ 4. 生成器高级用法 ══════")

    # send()：向生成器发送值
    acc = accumulator()
    next(acc)              # 启动生成器（必须先 next 一次）
    print(f"send(10): {acc.send(10)}")   # total=10
    print(f"send(20): {acc.send(20)}")   # total=30
    print(f"send(5): {acc.send(5)}")     # total=35

    # close()：关闭生成器（在 yield 处抛出 GeneratorExit）
    gen = fibonacci()
    next(gen)
    gen.close()   # 生成器被关闭，后续 next() 会 StopIteration


# ───────────────────────────────────────────────────────────────
# 5. itertools 标准库
# ───────────────────────────────────────────────────────────────
def demo_itertools():
    print("\n══════ 5. itertools ══════")

    # ── 无限迭代器 ──
    # count(start, step)：无限计数
    for i in itertools.islice(itertools.count(1, 2), 5):
        print(i, end=" ")     # 1 3 5 7 9
    print()

    # cycle(iterable)：无限循环
    colors = itertools.cycle(["红", "绿", "蓝"])
    print([next(colors) for _ in range(7)])

    # repeat(elem, n)：重复
    print(list(itertools.repeat("ha", 3)))

    # ── 组合迭代器 ──
    # chain：串联多个迭代器
    print(f"chain: {list(itertools.chain([1,2], [3,4], [5]))}")

    # zip_longest：最长的迭代器为准（内置 zip 以最短为准）
    print(f"zip_longest: {list(itertools.zip_longest([1,2,3], ['a','b'], fillvalue='?'))}")

    # product：笛卡尔积
    print(f"product: {list(itertools.product('AB', '12'))}")

    # permutations：排列
    print(f"permutations: {list(itertools.permutations('ABC', 2))}")

    # combinations：组合
    print(f"combinations: {list(itertools.combinations('ABCD', 2))}")

    # ── 过滤迭代器 ──
    # takewhile：取元素直到条件为 False
    print(f"takewhile: {list(itertools.takewhile(lambda x: x < 5, [1,3,5,2,4]))}")

    # dropwhile：丢弃元素直到条件为 False
    print(f"dropwhile: {list(itertools.dropwhile(lambda x: x < 5, [1,3,5,2,4]))}")

    # groupby：按 key 分组（⚠️ 数据必须先按 key 排序）
    data = sorted([("A", 1), ("B", 2), ("A", 3), ("B", 4)], key=lambda x: x[0])
    for key, group in itertools.groupby(data, key=lambda x: x[0]):
        print(f"  {key}: {list(group)}")


if __name__ == "__main__":
    demo_iterator()
    demo_generator()
    demo_yield_from()
    demo_advanced()
    demo_itertools()
