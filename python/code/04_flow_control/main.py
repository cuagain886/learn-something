"""
═══════════════════════════════════════════════════════════════════

    04_flow_control —— 流程控制：if / for / while / match

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. if / elif / else 条件语句
 2. for 循环（迭代为王）与 range()
 3. while 循环
 4. break / continue / else 子句（for-else 是 Python 特色！）
 5. match-case 结构化模式匹配（Python 3.10+）

【运行】python main.py

【与其他语言的核心差异】
  - Python 没有 switch，但有 match-case（3.10+），功能比 switch 强大得多
  - for 只有"for-each"形式（迭代），没有 C 风格的 for(i=0;i<n;i++)
  - for 和 while 都可以有 else 子句——循环正常结束（没被 break）时执行
  - 用缩进而非花括号，没有括号包裹条件
"""


def demo_if():
    print("══════ 1. if / elif / else ══════")

    score = 85

    # 基本 if-elif-else（注意冒号和缩进）
    if score >= 90:
        grade = "A"
    elif score >= 80:
        grade = "B"
    elif score >= 70:
        grade = "C"
    else:
        grade = "D"
    print(f"分数 {score} -> 等级 {grade}")

    # ⚠️ 条件不需要括号（加了也不报错但不 Pythonic）
    # if (score > 60):  # 可以但不推荐
    # if score > 60:    # 推荐

    # 条件表达式（三元，上一节讲过）
    result = "及格" if score >= 60 else "不及格"
    print(f"result = {result}")

    # 多条件组合
    age, has_id = 20, True
    if age >= 18 and has_id:
        print("允许进入")

    # ⚠️ Python 没有花括号，所以不存在 Go 那种 if 带初始化语句的语法
    # 但可以用海象运算符达到类似效果：
    data = [1, 2, 3]
    if (n := len(data)) > 0:
        print(f"列表非空，{n} 个元素")


def demo_for():
    print("\n══════ 2. for 循环 ══════")

    # Python 的 for 只有"for-each"形式：遍历可迭代对象
    # 没有 C 风格的 for(i=0; i<n; i++)

    # ── 遍历列表 ──
    fruits = ["苹果", "香蕉", "橘子"]
    for fruit in fruits:
        print(f"  {fruit}")

    # ── range() 生成整数序列 ──
    # range(stop)        -> 0, 1, ..., stop-1
    # range(start, stop) -> start, start+1, ..., stop-1
    # range(start, stop, step) -> start, start+step, ...
    print("range(5):", list(range(5)))           # [0, 1, 2, 3, 4]
    print("range(2,7):", list(range(2, 7)))      # [2, 3, 4, 5, 6]
    print("range(0,10,3):", list(range(0, 10, 3)))  # [0, 3, 6, 9]
    print("range(5,0,-1):", list(range(5, 0, -1)))  # [5, 4, 3, 2, 1]

    # 模拟 C 风格 for：
    for i in range(5):
        pass  # pass = 空语句占位符

    # ── enumerate()：同时获取索引和值 ──（⭐非常常用）
    for i, fruit in enumerate(fruits):
        print(f"  [{i}] {fruit}")

    # 指定起始索引
    for i, fruit in enumerate(fruits, start=1):
        print(f"  第{i}个: {fruit}")

    # ── zip()：同时遍历多个序列 ──
    names = ["Alice", "Bob", "Charlie"]
    ages = [25, 30, 35]
    for name, age in zip(names, ages):
        print(f"  {name} 今年 {age} 岁")

    # ── 遍历字典 ──
    scores = {"语文": 90, "数学": 95, "英语": 88}
    for subject, score in scores.items():
        print(f"  {subject}: {score}")

    # ── 嵌套循环 ──
    for i in range(3):
        for j in range(3):
            print(f"({i},{j})", end=" ")
        print()  # 换行


def demo_while():
    print("\n══════ 3. while 循环 ══════")

    # 基本 while
    count = 0
    while count < 5:
        print(f"  count = {count}")
        count += 1

    # while True + break（常见模式）
    total = 0
    while True:
        total += 1
        if total >= 3:
            break
    print(f"  break 后 total = {total}")

    # ⚠️ Python 没有 do-while，只能用 while True + break 模拟


def demo_break_continue_else():
    print("\n══════ 4. break / continue / for-else ══════")

    # break：终止最近的循环
    for i in range(10):
        if i == 5:
            break
        print(i, end=" ")
    print("  <- break at 5")

    # continue：跳过本轮剩余代码，进入下一轮
    for i in range(10):
        if i % 2 == 0:
            continue
        print(i, end=" ")
    print("  <- 只打印奇数")

    # ⭐ for-else / while-else：Python 特色语法！
    # else 块在循环【正常结束】（没被 break 打断）时执行
    # 典型场景：搜索时判断"是否找到"

    # 场景：在列表中查找目标
    numbers = [2, 4, 6, 8, 10]
    target = 7
    for n in numbers:
        if n == target:
            print(f"  找到 {target}")
            break
    else:
        # 循环正常结束（没有 break），说明没找到
        print(f"  {target} 不在列表中")

    # ⚠️ 没有 label/goto：Python 的 break 只能跳出一层循环
    # 跳出多层循环的惯用法：
    # 方法1：把多层循环提取为函数，用 return
    # 方法2：用标志变量


def demo_match():
    print("\n══════ 5. match-case 模式匹配（Python 3.10+） ══════")

    # match-case 不是简单的 switch！它是结构化模式匹配（structural pattern matching）

    # ── 基本用法（类似 switch） ──
    status = 404
    match status:
        case 200:
            print("  OK")
        case 404:
            print("  Not Found")
        case 500:
            print("  Internal Server Error")
        case _:                  # _ 是通配符，类似 default
            print("  Unknown")

    # ── 匹配多个值 ──
    command = "quit"
    match command:
        case "quit" | "exit" | "q":    # | 相当于 or
            print("  退出程序")
        case "help" | "h":
            print("  显示帮助")

    # ── 解构匹配（真正强大的地方） ──
    point = (3, 4)
    match point:
        case (0, 0):
            print("  原点")
        case (x, 0):
            print(f"  X 轴上，x = {x}")
        case (0, y):
            print(f"  Y 轴上，y = {y}")
        case (x, y):
            print(f"  点 ({x}, {y})")

    # ── 带守卫条件（guard） ──
    age = 25
    match age:
        case n if n < 0:
            print("  无效年龄")
        case n if n < 18:
            print("  未成年")
        case n if n < 65:
            print(f"  成年人，{n} 岁")
        case _:
            print("  老年人")


if __name__ == "__main__":
    demo_if()
    demo_for()
    demo_while()
    demo_break_continue_else()
    demo_match()
