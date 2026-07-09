"""
═══════════════════════════════════════════════════════════════════

    09_comprehensions —— 推导式：Python 的优雅武器

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. 列表推导式（list comprehension）
 2. 字典推导式（dict comprehension）
 3. 集合推导式（set comprehension）
 4. 生成器表达式（generator expression）
 5. 嵌套推导式与何时不该用推导式

【运行】python main.py

【与其他语言的对照】
  - 推导式是 Python 的标志性特性，直接来源于数学的集合构建符号
  - Go 没有推导式，只能写循环
  - JavaScript 的 map/filter 勉强接近，但推导式更简洁
  - ⭐ 写 Python 如果不用推导式，就像写 Go 不用 goroutine —— 少了灵魂
"""


def demo_list_comprehension():
    print("══════ 1. 列表推导式 ══════")

    # 基本语法：[表达式 for 变量 in 可迭代对象]
    squares = [x ** 2 for x in range(10)]
    print(f"平方: {squares}")

    # 带条件：[表达式 for 变量 in 可迭代 if 条件]
    evens = [x for x in range(20) if x % 2 == 0]
    print(f"偶数: {evens}")

    # 等价的传统写法（对比感受简洁度）：
    # evens = []
    # for x in range(20):
    #     if x % 2 == 0:
    #         evens.append(x)

    # 带表达式变换
    words = ["hello", "world", "python"]
    upper = [w.upper() for w in words]
    print(f"大写: {upper}")

    # 带 if-else（注意位置不同！）
    # if 在 for 后面 = 过滤
    # if-else 在 for 前面 = 变换
    labels = ["偶" if x % 2 == 0 else "奇" for x in range(6)]
    print(f"奇偶标签: {labels}")

    # 展平嵌套列表
    matrix = [[1, 2, 3], [4, 5, 6], [7, 8, 9]]
    flat = [x for row in matrix for x in row]
    print(f"展平: {flat}")
    # 等价于：
    # for row in matrix:
    #     for x in row:
    #         flat.append(x)

    # 嵌套推导式（生成矩阵）
    grid = [[i * 3 + j for j in range(3)] for i in range(3)]
    print(f"矩阵: {grid}")


def demo_dict_comprehension():
    print("\n══════ 2. 字典推导式 ══════")

    # 基本语法：{key: value for 变量 in 可迭代}
    squares = {x: x ** 2 for x in range(6)}
    print(f"平方字典: {squares}")

    # 键值反转
    original = {"a": 1, "b": 2, "c": 3}
    flipped = {v: k for k, v in original.items()}
    print(f"反转: {flipped}")

    # 过滤
    scores = {"Alice": 85, "Bob": 62, "Charlie": 91, "Diana": 58}
    passed = {name: score for name, score in scores.items() if score >= 60}
    print(f"及格: {passed}")

    # 从两个列表构建字典
    keys = ["name", "age", "city"]
    values = ["Alice", 30, "北京"]
    info = {k: v for k, v in zip(keys, values)}
    print(f"zip构建: {info}")
    # 更简洁的写法：dict(zip(keys, values))


def demo_set_comprehension():
    print("\n══════ 3. 集合推导式 ══════")

    # 基本语法：{表达式 for 变量 in 可迭代}
    nums = [1, 2, 2, 3, 3, 3, 4, 4, 4, 4]
    unique_squares = {x ** 2 for x in nums}
    print(f"去重平方: {unique_squares}")

    # 提取句子中的不重复单词（小写）
    sentence = "The quick brown fox jumps over the lazy dog the fox"
    unique_words = {word.lower() for word in sentence.split()}
    print(f"不重复单词: {unique_words}")


def demo_generator_expression():
    print("\n══════ 4. 生成器表达式 ══════")

    # 语法和列表推导式一样，只是把 [] 换成 ()
    # ⭐ 区别：生成器不会一次性生成所有元素，而是惰性计算（lazy evaluation）
    #    列表推导式 [x for x in range(1000000)] -> 立即分配内存存 100 万个元素
    #    生成器表达式 (x for x in range(1000000)) -> 按需生成，内存占用极小

    gen = (x ** 2 for x in range(10))
    print(f"生成器对象: {gen}")
    print(f"type: {type(gen)}")

    # 迭代生成器
    for val in gen:
        print(val, end=" ")
    print()

    # ⚠️ 生成器只能遍历一次！
    # for val in gen:   # 第二次遍历不会有任何输出
    #     print(val)

    # 生成器表达式作为函数参数时可以省略外层括号
    total = sum(x ** 2 for x in range(10))     # 不需要写 sum((x**2 ...))
    print(f"sum of squares: {total}")

    largest = max(len(w) for w in ["hello", "world", "python"])
    print(f"最长单词长度: {largest}")

    # 判断是否存在满足条件的元素
    has_negative = any(x < 0 for x in [1, -2, 3])
    all_positive = all(x > 0 for x in [1, 2, 3])
    print(f"有负数: {has_negative}, 全正数: {all_positive}")


def demo_best_practices():
    print("\n══════ 5. 推导式最佳实践 ══════")

    # ✓ 推导式适合的场景：
    #   - 简单的映射和过滤（1-2 层循环）
    #   - 逻辑一目了然
    #   - 结果直接使用

    # ✗ 不该用推导式的场景：
    #   - 逻辑复杂需要多步骤（可读性差）
    #   - 有副作用（推导式应该是纯表达式）
    #   - 超过 2 层嵌套

    # ⚠️ 反例：不要这样写！
    # result = [
    #     process(x, y, z)
    #     for x in range(10)
    #     for y in range(10)
    #     for z in range(10)
    #     if x + y + z < 15
    #     if x != y != z
    # ]
    # -> 拆成普通循环更清晰

    # ── 性能对比 ──
    import timeit

    n = 100_000

    # 列表推导式通常比等价的 for 循环快 10-30%
    # 因为推导式在 C 层面优化了，减少了 Python 层面的函数调用开销
    t1 = timeit.timeit(lambda: [x ** 2 for x in range(n)], number=10)
    t2 = timeit.timeit(lambda: list(map(lambda x: x ** 2, range(n))), number=10)

    def loop_version():
        result = []
        for x in range(n):
            result.append(x ** 2)
        return result
    t3 = timeit.timeit(loop_version, number=10)

    print(f"推导式: {t1:.4f}s")
    print(f"map:    {t2:.4f}s")
    print(f"循环:   {t3:.4f}s")


if __name__ == "__main__":
    demo_list_comprehension()
    demo_dict_comprehension()
    demo_set_comprehension()
    demo_generator_expression()
    demo_best_practices()
