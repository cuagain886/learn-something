"""
═══════════════════════════════════════════════════════════════════

    03_operators_fmt —— 运算符与格式化输出

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. 算术、比较、逻辑、位运算符
 2. Python 独有的运算符：//（整除）、**（幂）、海象运算符 :=
 3. 格式化输出三大方式：f-string / format / %
 4. f-string 的高级用法

【运行】python main.py

【与其他语言的核心差异】
  - Python 有三元表达式但语法不同：x if cond else y（而非 cond ? x : y）
  - and / or / not 用英文单词，不是 && || !
  - // 是整除运算符（Go/C 的 / 对整数就是整除，Python 不是）
  - ** 是幂运算（Go 要用 math.Pow）
  - Python 3.8+ 的 := 海象运算符可以在表达式中赋值
"""


def demo_arithmetic():
    print("══════ 1. 算术运算符 ══════")

    a, b = 17, 5
    print(f"{a} + {b} = {a + b}")       # 22    加
    print(f"{a} - {b} = {a - b}")       # 12    减
    print(f"{a} * {b} = {a * b}")       # 85    乘
    print(f"{a} / {b} = {a / b}")       # 3.4   ⚠️ 真除法，结果是 float！
    print(f"{a} // {b} = {a // b}")     # 3     整除（向下取整）
    print(f"{a} % {b} = {a % b}")       # 2     取余
    print(f"{a} ** {b} = {a ** b}")     # 1419857  幂运算

    # ⚠️ 关键差异：Python 3 的 / 是真除法
    # Go/C/Java: 7 / 2 = 3（整数除法）
    # Python 3:  7 / 2 = 3.5（真除法）  7 // 2 = 3（整除）
    print(f"7 / 2 = {7 / 2}")       # 3.5
    print(f"7 // 2 = {7 // 2}")     # 3

    # ⚠️ 负数整除的方向：Python 向负无穷取整，C/Go 向零取整
    print(f"-7 // 2 = {-7 // 2}")   # -4（Python）  Go 里是 -3
    print(f"-7 % 2 = {-7 % 2}")     # 1（Python）   Go 里是 -1

    # ++ 和 -- 不存在！
    # x++  # SyntaxError!
    # 只能写 x += 1


def demo_comparison():
    print("\n══════ 2. 比较运算符 ══════")

    print(f"5 == 5.0 : {5 == 5.0}")     # True（跨类型比较数值）
    print(f"5 != 3   : {5 != 3}")       # True
    print(f"5 > 3    : {5 > 3}")        # True

    # ⭐ Python 支持链式比较！（很多语言不支持）
    x = 5
    print(f"1 < {x} < 10 : {1 < x < 10}")       # True  等价于 1 < x and x < 10
    print(f"1 < {x} > 3  : {1 < x > 3}")         # True  也可以不等方向混用

    # == vs is
    a = [1, 2, 3]
    b = [1, 2, 3]
    print(f"a == b : {a == b}")     # True  值相等
    print(f"a is b : {a is b}")     # False 不是同一个对象
    # ⚠️ 规则：比较值用 ==，比较身份用 is。只有 None 才用 is 比较


def demo_logical():
    print("\n══════ 3. 逻辑运算符 ══════")

    # Python 用英文单词 and / or / not，不是符号
    print(f"True and False : {True and False}")   # False
    print(f"True or False  : {True or False}")    # True
    print(f"not True       : {not True}")         # False

    # ⭐ 短路求值 + 返回原始值（不一定是 bool！）
    # and：第一个为假返回第一个，否则返回第二个
    # or ：第一个为真返回第一个，否则返回第二个
    print(f"0 and 42   : {0 and 42}")       # 0（第一个为假，短路返回）
    print(f"42 and 99  : {42 and 99}")      # 99（第一个为真，返回第二个）
    print(f"0 or 42    : {0 or 42}")        # 42（第一个为假，返回第二个）
    print(f"42 or 99   : {42 or 99}")       # 42（第一个为真，短路返回）

    # 常用惯用法：提供默认值
    name = "" or "匿名用户"
    print(f"默认值惯用法: {name}")  # "匿名用户"


def demo_bitwise():
    print("\n══════ 4. 位运算符 ══════")

    a, b = 0b1010, 0b1100   # 10, 12
    print(f"a & b  = {a & b:04b} ({a & b})")    # 1000 (8)   与
    print(f"a | b  = {a | b:04b} ({a | b})")    # 1110 (14)  或
    print(f"a ^ b  = {a ^ b:04b} ({a ^ b})")    # 0110 (6)   异或
    print(f"~a     = {~a} ({bin(~a)})")          # -11        取反
    print(f"a << 2 = {a << 2:08b} ({a << 2})")  # 101000 (40) 左移
    print(f"a >> 1 = {a >> 1:04b} ({a >> 1})")  # 0101 (5)   右移


def demo_special_operators():
    print("\n══════ 5. Python 特色运算符 ══════")

    # 三元表达式（条件表达式）
    # 语法：值_if_true if 条件 else 值_if_false
    age = 20
    status = "成年" if age >= 18 else "未成年"
    print(f"age={age}, status={status}")

    # 海象运算符 := （Python 3.8+）
    # 在表达式内部赋值，避免重复计算
    data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    if (n := len(data)) > 5:
        print(f"海象运算符: 列表有 {n} 个元素，超过 5 个")

    # 成员运算符 in / not in
    fruits = ["苹果", "香蕉", "橘子"]
    print(f"'苹果' in fruits : {'苹果' in fruits}")       # True
    print(f"'葡萄' not in fruits : {'葡萄' not in fruits}")  # True

    # in 也可以检查字符串包含关系
    print(f"'Py' in 'Python' : {'Py' in 'Python'}")  # True


def demo_formatting():
    print("\n══════ 6. 格式化输出 ══════")

    name = "Alice"
    age = 30
    score = 95.678

    # ── 方式一：f-string（Python 3.6+，⭐推荐） ──
    print(f"姓名: {name}, 年龄: {age}")
    print(f"分数: {score:.2f}")            # 保留两位小数
    print(f"十六进制: {255:#x}")            # 0xff
    print(f"二进制: {10:#010b}")            # 0b00001010
    print(f"千分位: {1234567:,}")           # 1,234,567
    print(f"百分比: {0.856:.1%}")           # 85.6%
    print(f"左对齐: |{name:<10}|")         # |Alice     |
    print(f"右对齐: |{name:>10}|")         # |     Alice|
    print(f"居中:   |{name:^10}|")         # |  Alice   |

    # f-string 中可以写任意表达式
    print(f"2 + 3 = {2 + 3}")
    print(f"大写: {name.upper()}")

    # Python 3.12+：f-string 中可以嵌套引号
    # print(f"{'hello'}")  # 3.12 之前不允许，现在可以

    # 调试神器（Python 3.8+）：变量名=值 自动打印
    x, y = 10, 20
    print(f"{x=}, {y=}, {x+y=}")   # x=10, y=20, x+y=30

    # ── 方式二：str.format() ──
    print("姓名: {}, 年龄: {}".format(name, age))
    print("姓名: {0}, 再次: {0}".format(name))     # 索引复用
    print("姓名: {n}, 年龄: {a}".format(n=name, a=age))  # 命名参数

    # ── 方式三：% 格式化（旧式，了解即可） ──
    print("姓名: %s, 年龄: %d, 分数: %.2f" % (name, age, score))
    # %s=字符串  %d=整数  %f=浮点  %x=十六进制


if __name__ == "__main__":
    demo_arithmetic()
    demo_comparison()
    demo_logical()
    demo_bitwise()
    demo_special_operators()
    demo_formatting()
