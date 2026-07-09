"""
═══════════════════════════════════════════════════════════════════

    07_dicts_sets —— 字典与集合

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. 字典（dict）：键值对映射 —— Python 最重要的数据结构
 2. 集合（set）：无序不重复元素集
 3. 字典的高级用法：defaultdict、Counter、合并
 4. 集合运算：交并差对称差

【运行】python main.py

【与其他语言的对照】
  - dict ≈ Go 的 map / Java 的 HashMap
  - set  ≈ Go 用 map[T]struct{} 模拟的集合
  - Python 3.7+ 字典保证插入顺序（Go 的 map 遍历无序）
  - Python 的 dict 底层是哈希表，查找/插入/删除都是 O(1) 平均
"""


def demo_dict_basics():
    print("══════ 1. 字典基础 ══════")

    # 创建字典
    empty = {}
    scores = {"语文": 90, "数学": 95, "英语": 88}
    from_pairs = dict([("a", 1), ("b", 2)])    # 从键值对列表创建
    from_kwargs = dict(x=10, y=20)             # 从关键字参数创建

    print(f"scores = {scores}")

    # ── 增查改删 ──
    # 查：通过 key 访问
    print(f"scores['语文'] = {scores['语文']}")
    # scores["体育"]   # ⚠️ KeyError! key 不存在就报错

    # ⭐ get()：安全访问，key 不存在返回默认值
    print(f"scores.get('体育', 0) = {scores.get('体育', 0)}")   # 0

    # 增/改：直接赋值
    scores["体育"] = 85     # 新增
    scores["语文"] = 92     # 修改
    print(f"增改后: {scores}")

    # 删
    del scores["体育"]              # 删除指定 key（不存在则 KeyError）
    popped = scores.pop("英语")     # 弹出并返回值
    popped2 = scores.pop("物理", None)  # 不存在时返回默认值，不报错
    print(f"删除后: {scores}, popped={popped}")

    # ── 检查 key 是否存在 ──
    print(f"'数学' in scores: {'数学' in scores}")     # True
    print(f"'体育' in scores: {'体育' in scores}")     # False

    # ── 遍历 ──
    info = {"name": "Alice", "age": 30, "city": "北京"}
    for key in info:                    # 默认遍历 key
        print(f"  key: {key}")

    for key, value in info.items():     # ⭐ 遍历键值对（最常用）
        print(f"  {key} = {value}")

    for value in info.values():         # 只遍历值
        pass

    # ── 字典保证插入顺序（Python 3.7+） ──
    # 这是语言规范保证的，不像 Go 的 map 每次遍历顺序随机


def demo_dict_advanced():
    print("\n══════ 2. 字典高级用法 ══════")

    # ── setdefault()：key 不存在时设置默认值 ──
    word_count = {}
    words = ["apple", "banana", "apple", "cherry", "banana", "apple"]
    for word in words:
        word_count.setdefault(word, 0)
        word_count[word] += 1
    print(f"setdefault 计数: {word_count}")

    # ── collections.defaultdict：更优雅的默认值 ──
    from collections import defaultdict

    dd = defaultdict(int)       # 默认值是 int() = 0
    for word in words:
        dd[word] += 1           # key 不存在时自动创建，值为 0
    print(f"defaultdict 计数: {dict(dd)}")

    dd_list = defaultdict(list)  # 默认值是 list() = []
    pairs = [("a", 1), ("b", 2), ("a", 3), ("b", 4)]
    for key, value in pairs:
        dd_list[key].append(value)
    print(f"defaultdict(list): {dict(dd_list)}")

    # ── collections.Counter：专业计数器 ──
    from collections import Counter

    counter = Counter(words)
    print(f"Counter: {counter}")
    print(f"最常见的2个: {counter.most_common(2)}")

    # ── 字典合并 ──
    a = {"x": 1, "y": 2}
    b = {"y": 3, "z": 4}

    # 方式一：** 解包（Python 3.5+）
    merged = {**a, **b}        # b 的 y 覆盖 a 的 y
    print(f"**合并: {merged}")

    # 方式二：| 运算符（Python 3.9+，⭐推荐）
    merged2 = a | b
    print(f"|合并: {merged2}")

    # 原地合并
    a |= b                     # a.update(b) 的等价写法
    print(f"|= 合并: {a}")

    # ── 字典推导式 ──（第 09 节详讲）
    squares = {x: x**2 for x in range(6)}
    print(f"字典推导式: {squares}")


def demo_set():
    print("\n══════ 3. 集合（set） ══════")

    # 集合：无序、不重复、可哈希元素
    fruits = {"苹果", "香蕉", "橘子", "苹果"}   # 重复自动去掉
    print(f"fruits = {fruits}")          # 只有 3 个元素
    print(f"len = {len(fruits)}")

    # ⚠️ 空集合必须用 set()，不能用 {}（{} 是空字典！）
    empty_set = set()
    empty_dict = {}
    print(f"type(set()) = {type(empty_set)}")    # <class 'set'>
    print(f"type({{}}) = {type(empty_dict)}")     # <class 'dict'>

    # ── 增删 ──
    fruits.add("葡萄")          # 添加
    fruits.discard("香蕉")      # 删除（不存在不报错）
    fruits.remove("橘子")       # 删除（不存在 KeyError）
    print(f"增删后: {fruits}")

    # ── 成员测试（O(1)！比列表的 O(n) 快得多） ──
    print(f"'苹果' in fruits: {'苹果' in fruits}")

    # ── 从列表去重 ──
    nums = [1, 3, 2, 3, 1, 4, 2]
    unique = list(set(nums))    # ⚠️ 顺序会打乱
    print(f"去重: {unique}")

    # 保持顺序去重（Python 3.7+）
    unique_ordered = list(dict.fromkeys(nums))
    print(f"保序去重: {unique_ordered}")


def demo_set_operations():
    print("\n══════ 4. 集合运算 ══════")

    a = {1, 2, 3, 4, 5}
    b = {4, 5, 6, 7, 8}

    # 交集
    print(f"a & b (交集)   = {a & b}")        # {4, 5}
    print(f"a.intersection(b) = {a.intersection(b)}")

    # 并集
    print(f"a | b (并集)   = {a | b}")        # {1,2,3,4,5,6,7,8}

    # 差集
    print(f"a - b (差集)   = {a - b}")        # {1, 2, 3}

    # 对称差集（在 a 或 b 中，但不同时在两者中）
    print(f"a ^ b (对称差) = {a ^ b}")        # {1, 2, 3, 6, 7, 8}

    # 子集/超集
    c = {1, 2}
    print(f"{c} <= {a} (子集): {c <= a}")      # True
    print(f"{a} >= {c} (超集): {a >= c}")       # True

    # ── frozenset：不可变集合 ──
    # 可以做字典的 key 或放入另一个 set
    fs = frozenset([1, 2, 3])
    print(f"frozenset: {fs}")
    # fs.add(4)  # ⚠️ AttributeError


def demo_practical():
    print("\n══════ 5. 实用场景 ══════")

    # 场景1：用 dict 做配置
    config = {
        "host": "localhost",
        "port": 8080,
        "debug": True,
        "allowed_origins": ["http://localhost:3000"],
    }
    host = config.get("host", "0.0.0.0")
    print(f"config host: {host}")

    # 场景2：用 set 做高效查找
    valid_users = {"alice", "bob", "charlie"}
    user = "bob"
    if user in valid_users:    # O(1) 查找
        print(f"  {user} 是有效用户")

    # 场景3：用 Counter 做词频统计
    from collections import Counter
    text = "the quick brown fox jumps over the lazy dog the fox"
    word_freq = Counter(text.split())
    print(f"  词频: {word_freq.most_common(3)}")

    # 场景4：dict 实现简易缓存
    cache = {}
    def expensive_compute(n):
        if n not in cache:
            cache[n] = n ** 2   # 模拟耗时计算
        return cache[n]

    print(f"  缓存: {expensive_compute(42)}")


if __name__ == "__main__":
    demo_dict_basics()
    demo_dict_advanced()
    demo_set()
    demo_set_operations()
    demo_practical()
