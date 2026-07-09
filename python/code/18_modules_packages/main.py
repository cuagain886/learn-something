"""
═══════════════════════════════════════════════════════════════════

    18_modules_packages —— 模块与包

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. 模块（module）：一个 .py 文件就是一个模块
 2. 包（package）：包含 __init__.py 的目录
 3. 导入的各种方式与最佳实践
 4. __all__、__name__、__init__.py 的作用
 5. 虚拟环境与依赖管理（venv / pip）

【运行】python main.py

【与其他语言的对照】
  - Go 的包 = 一个目录下的所有 .go 文件（包名和目录名对应）
  - Python 的模块 = 单个 .py 文件；包 = 含 __init__.py 的目录
  - Go 用 go mod 管理依赖；Python 用 pip + requirements.txt / pyproject.toml
  - Go 的导出规则是首字母大写；Python 用 _ 前缀和 __all__
"""
import sys
import os

# 导入自定义包（同目录下的 myutils 包）
from myutils import math_tools
from myutils.string_tools import reverse_string


# ───────────────────────────────────────────────────────────────
# 1. 模块与导入方式
# ───────────────────────────────────────────────────────────────
def demo_imports():
    print("══════ 1. 导入方式 ══════")

    # 方式一：import 模块
    import json
    data = json.dumps({"name": "Alice"})
    print(f"  json.dumps: {data}")

    # 方式二：from 模块 import 名字
    from math import sqrt, pi
    print(f"  sqrt(16) = {sqrt(16)}, pi = {pi:.4f}")

    # 方式三：import 模块 as 别名
    import datetime as dt
    now = dt.datetime.now()
    print(f"  now = {now}")

    # 方式四：from 模块 import 名字 as 别名
    from collections import OrderedDict as OD
    od = OD(a=1, b=2)
    print(f"  OrderedDict: {od}")

    # ⚠️ 不推荐的写法：from xxx import *
    # 原因：污染命名空间，不知道导入了什么，容易名字冲突
    # 唯一合理的场景：交互式调试时方便

    # ── 导入惯例（PEP 8） ──
    # 1. 标准库导入
    # 2. 第三方库导入（空一行）
    # 3. 本地导入（空一行）
    # 每组内按字母排序


# ───────────────────────────────────────────────────────────────
# 2. 模块搜索路径
# ───────────────────────────────────────────────────────────────
def demo_search_path():
    print("\n══════ 2. 模块搜索路径 ══════")

    # Python 按以下顺序搜索模块：
    # 1. 当前目录
    # 2. PYTHONPATH 环境变量中的目录
    # 3. 标准库目录
    # 4. site-packages（第三方包安装目录）

    print("  sys.path (前5个):")
    for p in sys.path[:5]:
        print(f"    {p}")

    # 动态添加搜索路径（不推荐，调试用）：
    # sys.path.insert(0, "/path/to/my/modules")


# ───────────────────────────────────────────────────────────────
# 3. 使用自定义包
# ───────────────────────────────────────────────────────────────
def demo_custom_package():
    print("\n══════ 3. 自定义包 ══════")

    # 使用 myutils 包中的函数
    print(f"  add(3, 4) = {math_tools.add(3, 4)}")
    print(f"  factorial(5) = {math_tools.factorial(5)}")
    print(f"  reverse('hello') = {reverse_string('hello')}")


# ───────────────────────────────────────────────────────────────
# 4. __name__ 与模块执行
# ───────────────────────────────────────────────────────────────
def demo_name():
    print("\n══════ 4. __name__ ══════")

    # __name__ 的值：
    #   直接运行：__name__ == "__main__"
    #   被导入时：__name__ == 模块名（如 "myutils.math_tools"）

    print(f"  当前模块 __name__ = {__name__}")
    print(f"  math_tools.__name__ = {math_tools.__name__}")

    # 这就是 if __name__ == "__main__": 的原理
    # 它让模块既可以被导入使用，又可以独立运行


# ───────────────────────────────────────────────────────────────
# 5. 虚拟环境与依赖管理
# ───────────────────────────────────────────────────────────────
def demo_venv():
    print("\n══════ 5. 虚拟环境与依赖管理 ══════")

    info = """
    ── 虚拟环境（推荐！每个项目独立的 Python 环境） ──

    # 创建虚拟环境
    python -m venv .venv

    # 激活（Windows PowerShell）
    .venv\\Scripts\\Activate.ps1

    # 激活（Linux/Mac）
    source .venv/bin/activate

    # 退出虚拟环境
    deactivate

    ── pip 包管理 ──

    pip install requests           # 安装包
    pip install requests==2.31.0   # 安装指定版本
    pip install -r requirements.txt # 从文件安装所有依赖
    pip freeze > requirements.txt  # 导出当前依赖
    pip list                       # 列出已安装的包
    pip uninstall requests         # 卸载

    ── 现代工具（推荐） ──

    # uv：极快的包管理器（Rust 写的，替代 pip + venv）
    uv venv                        # 创建虚拟环境
    uv pip install requests        # 安装包

    # pyproject.toml：现代项目配置（替代 setup.py + requirements.txt）
    # 支持工具：Poetry、PDM、Hatch、uv
    """
    print(info)


if __name__ == "__main__":
    demo_imports()
    demo_search_path()
    demo_custom_package()
    demo_name()
    demo_venv()
