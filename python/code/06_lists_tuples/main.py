"""
═══════════════════════════════════════════════════════════════════

    06_lists_tuples —— 列表与元组

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. 列表（list）：可变有序序列 —— Python 的"瑞士军刀"
 2. 元组（tuple）：不可变有序序列
 3. 切片（slicing）：Python 最优雅的语法之一
 4. 常用方法与操作
 5. 列表与元组的使用场景对比

【运行】python main.py

【与其他语言的对照】
  - list ≈ Go 的切片 / Java 的 ArrayList，但可以存不同类型的元素
  - tuple ≈ 不可变的列表，常用作函数多返回值、字典的 key
  - Python 的切片支持负索引和步长，比 Go 灵活得多
"""


def demo_list_basics():
    print("══════ 1. 列表基础 ══════")

    # 创建列表
    empty = []
    nums = [1, 2, 3, 4, 5]
    mixed = [1, "hello", 3.14, True, None]   # 可以混合类型（但不推荐）
    nested = [[1, 2], [3, 4], [5, 6]]        # 嵌套列表

    print(f"nums = {nums}")
    print(f"mixed = {mixed}")
    print(f"len(nums) = {len(nums)}")

    # 索引访问（从 0 开始）
    print(f"nums[0] = {nums[0]}")     # 1   第一个
    print(f"nums[-1] = {nums[-1]}")   # 5   ⭐ 负索引：从末尾倒数
    print(f"nums[-2] = {nums[-2]}")   # 4

    # ── 切片 slicing ──（⭐核心语法）
    # 语法：list[start:stop:step]
    # start 默认 0，stop 默认 len，step 默认 1
    # 规则：包含 start，不包含 stop（左闭右开）
    print(f"nums[1:4] = {nums[1:4]}")     # [2, 3, 4]
    print(f"nums[:3]  = {nums[:3]}")      # [1, 2, 3]   从头开始
    print(f"nums[2:]  = {nums[2:]}")      # [3, 4, 5]   到末尾
    print(f"nums[::2] = {nums[::2]}")     # [1, 3, 5]   步长 2
    print(f"nums[::-1] = {nums[::-1]}")   # [5, 4, 3, 2, 1]  ⭐ 反转！

    # 切片创建新列表（浅拷贝）
    copy = nums[:]          # 完整切片 = 浅拷贝（等价于 nums.copy()）
    copy[0] = 999
    print(f"修改 copy 后，原 nums = {nums}")  # 不受影响


def demo_list_methods():
    print("\n══════ 2. 列表常用方法 ══════")

    nums = [3, 1, 4, 1, 5, 9, 2, 6]

    # ── 增 ──
    nums.append(7)             # 末尾添加一个元素          O(1)
    nums.insert(0, 0)          # 指定位置插入              O(n)
    nums.extend([8, 10])       # 末尾扩展多个元素          O(k)
    # nums += [8, 10]          # 等价于 extend
    print(f"增加后: {nums}")

    # ── 删 ──
    nums.remove(1)             # 删除第一个值为 1 的元素    O(n)
    popped = nums.pop()        # 弹出末尾元素              O(1)
    popped_i = nums.pop(0)     # 弹出指定位置              O(n)
    del nums[0]                # 删除指定位置（del 语句）
    print(f"删除后: {nums}, popped={popped}, popped_i={popped_i}")

    # nums.clear()             # 清空列表

    # ── 查 ──
    print(f"4 in nums: {4 in nums}")           # 成员测试  O(n)
    print(f"index of 5: {nums.index(5)}")       # 查找索引（不存在则 ValueError）
    print(f"count of 1: {nums.count(1)}")       # 计数

    # ── 排序 ──
    nums.sort()                # 原地排序（修改原列表）
    print(f"sort() 后: {nums}")
    nums.sort(reverse=True)    # 降序
    print(f"降序: {nums}")

    # sorted() 返回新列表，不修改原列表
    original = [3, 1, 2]
    new_sorted = sorted(original)
    print(f"sorted(): original={original}, new={new_sorted}")

    # 自定义排序（key 参数）
    words = ["banana", "apple", "cherry"]
    words.sort(key=len)        # 按长度排序
    print(f"按长度排序: {words}")

    # ── 反转 ──
    nums.reverse()             # 原地反转
    # reversed(nums)           # 返回迭代器，不修改原列表


def demo_list_operations():
    print("\n══════ 3. 列表操作与技巧 ══════")

    # ── 拼接与重复 ──
    a = [1, 2]
    b = [3, 4]
    print(f"a + b = {a + b}")       # [1, 2, 3, 4]  拼接
    print(f"a * 3 = {a * 3}")       # [1, 2, 1, 2, 1, 2]  重复

    # ⚠️ * 重复的陷阱：嵌套列表会共享引用！
    grid = [[0] * 3] * 3           # ⚠️ 3 行都是同一个列表！
    grid[0][0] = 1
    print(f"  陷阱: {grid}")        # [[1,0,0],[1,0,0],[1,0,0]]  全改了！

    # 正确写法：
    grid = [[0] * 3 for _ in range(3)]   # 每行是独立的列表
    grid[0][0] = 1
    print(f"  正确: {grid}")        # [[1,0,0],[0,0,0],[0,0,0]]  ✓

    # ── 深拷贝 vs 浅拷贝 ──
    import copy
    original = [[1, 2], [3, 4]]
    shallow = original.copy()       # 浅拷贝：内层列表仍共享
    deep = copy.deepcopy(original)  # 深拷贝：完全独立

    original[0][0] = 999
    print(f"  shallow[0][0] = {shallow[0][0]}")  # 999  ⚠️ 被影响
    print(f"  deep[0][0] = {deep[0][0]}")        # 1    ✓ 不受影响

    # ── 切片赋值（原地修改列表的一段） ──
    nums = [0, 1, 2, 3, 4, 5]
    nums[1:4] = [10, 20]          # 替换索引 1-3，长度可不同
    print(f"  切片赋值后: {nums}")   # [0, 10, 20, 4, 5]

    # ── 用 * 解包 ──
    first, *middle, last = [1, 2, 3, 4, 5]
    print(f"  first={first}, middle={middle}, last={last}")


def demo_tuple():
    print("\n══════ 4. 元组（tuple） ══════")

    # 元组是不可变的有序序列
    point = (3, 4)
    rgb = (255, 128, 0)
    single = (42,)                # ⚠️ 单元素元组必须加逗号！(42) 只是数字 42

    print(f"point = {point}")
    print(f"type((42,)) = {type(single)}")
    print(f"type((42)) = {type((42))}")  # int！不是 tuple

    # 索引和切片（和列表一样）
    print(f"point[0] = {point[0]}")
    print(f"rgb[1:] = {rgb[1:]}")

    # 不可变：不能修改、添加、删除元素
    # point[0] = 10  # ⚠️ TypeError!

    # ⚠️ 但元组内的可变元素仍可修改！
    t = ([1, 2], [3, 4])
    t[0].append(3)                # 列表本身是可变的
    print(f"  元组内修改列表: {t}")  # ([1, 2, 3], [3, 4])

    # ── 元组解包 ──
    x, y = point                   # 最常见的用法
    print(f"  解包: x={x}, y={y}")

    # ── 命名元组（NamedTuple）──
    from collections import namedtuple
    Point = namedtuple("Point", ["x", "y"])
    p = Point(3, 4)
    print(f"  NamedTuple: {p}, x={p.x}, y={p.y}")

    # 更现代的写法（Python 3.6+）：
    from typing import NamedTuple
    class Point3D(NamedTuple):
        x: float
        y: float
        z: float = 0.0   # 可以有默认值
    p3 = Point3D(1, 2)
    print(f"  typing.NamedTuple: {p3}")


def demo_when_to_use():
    print("\n══════ 5. 何时用列表 vs 元组 ══════")

    # 列表（list）：
    #   - 同类元素的集合（虽然可以混合类型，但不推荐）
    #   - 需要增删改的场景
    #   - 例：一组用户名、一批分数

    # 元组（tuple）：
    #   - 不同含义的字段组合（像简易的 struct）
    #   - 函数返回多个值
    #   - 做字典的 key（因为不可变，可哈希）
    #   - 不希望被修改的数据

    # 元组做字典 key（列表不行）
    locations = {
        (40.7128, -74.0060): "New York",
        (35.6762, 139.6503): "Tokyo",
    }
    print(f"  坐标查城市: {locations[(40.7128, -74.0060)]}")

    # ⚠️ 列表不能做字典的 key
    # d = {[1,2]: "value"}  # TypeError: unhashable type: 'list'


if __name__ == "__main__":
    demo_list_basics()
    demo_list_methods()
    demo_list_operations()
    demo_tuple()
    demo_when_to_use()
