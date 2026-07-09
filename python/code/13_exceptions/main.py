"""
═══════════════════════════════════════════════════════════════════

    13_exceptions —— 异常处理

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. try / except / else / finally 完整语法
 2. 常见内置异常层次结构
 3. 自定义异常
 4. 异常链（exception chaining）
 5. EAFP vs LBYL 编程风格

【运行】python main.py

【与其他语言的核心差异】
  - Go：返回 error 值，没有 try/catch。errors.Is/As 做类型判断
  - Python：用异常控制流（try/except），异常是正常控制手段不是错误
  - Python 的 for 循环靠 StopIteration 异常终止——异常不一定意味着"出错"
  - Python 鼓励 EAFP（先做再说）而非 LBYL（先检查再做）
"""


# ───────────────────────────────────────────────────────────────
# 1. try / except / else / finally
# ───────────────────────────────────────────────────────────────
def demo_basic():
    print("══════ 1. 基本异常处理 ══════")

    # 完整语法：
    # try:
    #     可能出错的代码
    # except 异常类型 as e:
    #     处理异常
    # else:
    #     没有异常时执行（可选）
    # finally:
    #     无论如何都执行（可选）

    def safe_divide(a, b):
        try:
            result = a / b
        except ZeroDivisionError as e:
            print(f"  捕获异常: {e}")
            return None
        except TypeError as e:
            print(f"  类型错误: {e}")
            return None
        else:
            # 没有异常才执行（比把代码放 try 里更清晰）
            print(f"  {a} / {b} = {result}")
            return result
        finally:
            # 无论如何都执行（清理资源用）
            print(f"  finally: 清理完毕")

    safe_divide(10, 3)
    safe_divide(10, 0)
    safe_divide("10", 3)

    # 捕获多种异常
    try:
        x = int("not_a_number")
    except (ValueError, TypeError) as e:
        print(f"  多异常: {type(e).__name__}: {e}")

    # 捕获所有异常（⚠️ 一般不推荐，调试困难）
    try:
        1 / 0
    except Exception as e:
        print(f"  Exception 基类: {type(e).__name__}: {e}")

    # ⚠️ 不要用 bare except（连 KeyboardInterrupt 都捕获了）
    # try: ...
    # except:   # 不推荐！连 Ctrl+C 都拦截
    #     pass


# ───────────────────────────────────────────────────────────────
# 2. 异常层次结构
# ───────────────────────────────────────────────────────────────
def demo_hierarchy():
    print("\n══════ 2. 异常层次结构 ══════")

    hierarchy = """
    BaseException
    ├── SystemExit            # sys.exit() 抛出
    ├── KeyboardInterrupt     # Ctrl+C
    ├── GeneratorExit         # 生成器关闭
    └── Exception             # ⭐ 所有"正常"异常的基类
        ├── ValueError        # 值不合法（如 int("abc")）
        ├── TypeError         # 类型不对（如 "1" + 2）
        ├── KeyError          # 字典 key 不存在
        ├── IndexError        # 索引越界
        ├── AttributeError    # 属性不存在
        ├── FileNotFoundError # 文件不存在
        ├── IOError           # I/O 错误
        ├── RuntimeError      # 运行时错误
        ├── StopIteration     # 迭代器耗尽
        ├── ImportError       # 导入失败
        │   └── ModuleNotFoundError
        ├── OSError           # 操作系统错误
        │   ├── FileNotFoundError
        │   ├── PermissionError
        │   └── TimeoutError
        └── ...
    """
    print(hierarchy)

    # ⚠️ except 的顺序很重要：子类要放在父类前面
    # try:
    #     ...
    # except Exception:       # 如果这个在前面
    #     pass
    # except ValueError:      # 这个永远不会被触发！
    #     pass


# ───────────────────────────────────────────────────────────────
# 3. raise 抛出异常
# ───────────────────────────────────────────────────────────────
def demo_raise():
    print("\n══════ 3. raise 抛出异常 ══════")

    def validate_age(age):
        if not isinstance(age, int):
            raise TypeError(f"age 必须是 int，得到 {type(age).__name__}")
        if age < 0 or age > 150:
            raise ValueError(f"age 必须在 0-150 之间，得到 {age}")
        return age

    try:
        validate_age(-5)
    except ValueError as e:
        print(f"  ValueError: {e}")

    try:
        validate_age("twenty")
    except TypeError as e:
        print(f"  TypeError: {e}")

    # re-raise：处理后重新抛出
    def process():
        try:
            int("abc")
        except ValueError:
            print("  记录日志...")
            raise   # 不带参数的 raise = 重新抛出当前异常

    try:
        process()
    except ValueError as e:
        print(f"  重新捕获: {e}")


# ───────────────────────────────────────────────────────────────
# 4. 自定义异常
# ───────────────────────────────────────────────────────────────
class AppError(Exception):
    """应用级异常基类"""
    pass


class ValidationError(AppError):
    """验证错误"""
    def __init__(self, field, message):
        self.field = field
        self.message = message
        super().__init__(f"{field}: {message}")


class NotFoundError(AppError):
    """资源未找到"""
    def __init__(self, resource, id_):
        self.resource = resource
        self.id_ = id_
        super().__init__(f"{resource} with id={id_} not found")


def demo_custom_exception():
    print("\n══════ 4. 自定义异常 ══════")

    def create_user(name, age):
        if not name:
            raise ValidationError("name", "不能为空")
        if age < 0:
            raise ValidationError("age", "不能为负数")
        return {"name": name, "age": age}

    try:
        create_user("", 25)
    except ValidationError as e:
        print(f"  字段: {e.field}, 消息: {e.message}")

    # 可以用 isinstance 按层次捕获
    try:
        raise NotFoundError("User", 42)
    except AppError as e:
        print(f"  AppError 捕获: {type(e).__name__}: {e}")


# ───────────────────────────────────────────────────────────────
# 5. 异常链（exception chaining）
# ───────────────────────────────────────────────────────────────
def demo_chaining():
    print("\n══════ 5. 异常链 ══════")

    # raise ... from ...：显式异常链
    def parse_config(text):
        try:
            return int(text)
        except ValueError as e:
            raise AppError(f"配置解析失败: {text!r}") from e

    try:
        parse_config("not_a_number")
    except AppError as e:
        print(f"  AppError: {e}")
        print(f"  原始异常: {e.__cause__}")    # ValueError


# ───────────────────────────────────────────────────────────────
# 6. EAFP vs LBYL
# ───────────────────────────────────────────────────────────────
def demo_eafp_lbyl():
    print("\n══════ 6. EAFP vs LBYL ══════")

    data = {"name": "Alice", "age": 30}

    # LBYL（Look Before You Leap）—— 先检查再操作
    # Go 风格，也是 C/Java 的常见风格
    if "email" in data:
        email = data["email"]
    else:
        email = "N/A"
    print(f"  LBYL: email = {email}")

    # EAFP（Easier to Ask Forgiveness than Permission）—— 先做再说
    # ⭐ Python 推崇的风格
    try:
        email = data["email"]
    except KeyError:
        email = "N/A"
    print(f"  EAFP: email = {email}")

    # 实际上最 Pythonic 的写法：
    email = data.get("email", "N/A")
    print(f"  get(): email = {email}")

    # EAFP 的优势：
    # 1. 在多线程环境中，LBYL 的检查和操作之间可能有竞态
    # 2. 有时检查条件的开销比直接尝试更大
    # 3. 代码更简洁（只处理异常路径）


if __name__ == "__main__":
    demo_basic()
    demo_hierarchy()
    demo_raise()
    demo_custom_exception()
    demo_chaining()
    demo_eafp_lbyl()
