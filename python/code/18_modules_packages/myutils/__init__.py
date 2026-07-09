"""
myutils 包的初始化文件

__init__.py 的作用：
1. 标记目录为 Python 包（Python 3.3+ 可以没有，但推荐保留）
2. 包导入时自动执行（可以做初始化、设置 __all__ 等）
3. 控制 from package import * 时导出什么

⚠️ Python 3.3+ 支持"命名空间包"（没有 __init__.py），
   但传统包（有 __init__.py）更明确，推荐使用
"""

# __all__ 控制 from myutils import * 时导出哪些名字
__all__ = ["math_tools", "string_tools"]
