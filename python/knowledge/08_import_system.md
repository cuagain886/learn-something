# 08 · 导入系统（Import System） ⭐⭐

> Python 的导入机制比 `import xxx` 看上去复杂得多——理解 finder/loader/sys.path/`__init__.py` 的协作，才能解决"模块找不到"和"循环导入"这两个高频问题。

---

## 1. 导入的完整流程

```python
import foo
```

实际执行流程：

```
1. 检查 sys.modules 缓存 → 如果已导入，直接返回
2. 遍历 sys.meta_path 中的 finder → 查找模块
3. finder 返回 module spec → 包含 loader 信息
4. loader 加载模块 → 执行模块代码，创建 module 对象
5. 将 module 对象存入 sys.modules → 缓存
6. 将名字绑定到当前命名空间
```

```python
import sys

# sys.modules：已导入模块的缓存（dict）
print("json" in sys.modules)   # 导入前：False
import json
print("json" in sys.modules)   # 导入后：True

# 每个模块只执行一次！重复 import 直接返回缓存
```

---

## 2. 模块搜索路径 sys.path

```python
import sys
for p in sys.path:
    print(p)

# 搜索顺序：
# 1. 脚本所在目录（或当前目录）
# 2. PYTHONPATH 环境变量
# 3. 标准库目录
# 4. site-packages（第三方包）
```

---

## 3. 包与 `__init__.py`

```
mypackage/
├── __init__.py          # 包的初始化文件
├── module_a.py
├── module_b.py
└── subpackage/
    ├── __init__.py
    └── module_c.py
```

- `import mypackage` → 执行 `mypackage/__init__.py`
- `from mypackage import module_a` → 先执行 `__init__.py`，再导入 `module_a`

### `__init__.py` 的常见用途

```python
# mypackage/__init__.py

# 1. 控制 from package import * 的行为
__all__ = ["module_a", "module_b"]

# 2. 提升常用 API 到包级别
from .module_a import important_func

# 3. 包级别初始化（日志、配置等）
print("mypackage 初始化")
```

---

## 4. 相对导入 vs 绝对导入

```python
# 绝对导入（推荐）
from mypackage.module_a import func

# 相对导入（只在包内部使用）
from . import module_a          # 同级目录
from .module_a import func      # 同级模块的名字
from .. import module_b         # 上一级目录
from ..subpackage import module_c  # 上一级的子包
```

⚠️ **相对导入只在包内有效**。直接运行 `python module_a.py` 会报 `ImportError`，因为此时没有包上下文。解决方法：`python -m mypackage.module_a`

---

## 5. 循环导入

```python
# a.py
from b import func_b
def func_a():
    return "a"

# b.py
from a import func_a    # ⚠️ 循环导入！
def func_b():
    return "b"
```

### 为什么会报错？

```
1. 导入 a.py → 开始执行 a.py
2. a.py 第一行：from b import func_b → 去导入 b.py
3. b.py 第一行：from a import func_a → 去导入 a.py
4. sys.modules 中 a 已存在（但还没执行完！）→ 返回半成品
5. 半成品 a 中还没有 func_a → ImportError!
```

### 解决方案

```python
# 方案 1：延迟导入（移到函数内部）
def func_b():
    from a import func_a   # 调用时才导入
    return func_a()

# 方案 2：重构，提取共同依赖到第三个模块

# 方案 3：用 import 模块而非 from 模块 import 名字
import a           # 导入模块对象，不立即访问属性
def func_b():
    return a.func_a()   # 调用时才访问属性
```

---

## 6. 常见导入陷阱

### 陷阱 1：同名模块遮蔽标准库

```python
# 文件名叫 json.py，会遮蔽标准库的 json
import json   # 导入的是自己！不是标准库
```

### 陷阱 2：`from xxx import *` 的污染

```python
from os.path import *   # 导入了几十个名字，可能和你的变量冲突
```

### 陷阱 3：`__all__` 只影响 `import *`

```python
# module.py
__all__ = ["public_func"]
def public_func(): ...
def _private_func(): ...

from module import *          # 只导入 public_func
from module import _private_func  # 仍然可以！__all__ 不阻止显式导入
```

---

## 高频面试题

**Q1：Python 的模块搜索顺序是什么？**
A：当前目录 → PYTHONPATH → 标准库 → site-packages。具体路径在 `sys.path` 中。

**Q2：模块会被执行多次吗？**
A：不会。首次导入时执行并缓存到 `sys.modules`，后续导入直接返回缓存。可以用 `importlib.reload()` 强制重新执行。

**Q3：如何解决循环导入？**
A：1) 延迟导入（移到函数内部）；2) 重构代码消除循环依赖；3) 用 `import module` 代替 `from module import name`。

---

## 一句话总结

Python 导入经历 finder→loader→缓存三步，模块只执行一次并缓存到 `sys.modules`；循环导入的根因是"模块还没执行完就被二次导入"，延迟导入是最常见的解法。
