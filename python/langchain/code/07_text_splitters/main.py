"""
═══════════════════════════════════════════════════════════════════
 07_text_splitters —— 文本分割器
═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. 为什么要分割文本
 2. RecursiveCharacterTextSplitter（最常用）
 3. 按 token 分割
 4. 按代码语言分割
 5. 语义分割
 6. 分割参数调优

【为什么不直接把整个文档扔给 LLM】
  1. LLM 有 token 限制（即使是 128K，放太多也降低质量）
  2. 嵌入模型通常针对短文本优化（512-8192 tokens）
  3. 检索时只需要相关片段，不需要整个文档
  4. 小块文本 → 更精确的语义匹配

【运行】python main.py
"""
from dotenv import load_dotenv
load_dotenv()

SAMPLE_TEXT = """
# LangChain 简介

LangChain 是一个用于开发大语言模型应用的框架。它提供了一系列工具和抽象，
帮助开发者更容易地构建基于 LLM 的应用程序。

## 核心组件

LangChain 的核心组件包括：

1. **Models** - 封装了各种 LLM API 的统一接口
2. **Prompts** - 管理和优化提示词的模板系统
3. **Chains** - 将多个组件组合成端到端的工作流
4. **Memory** - 在对话中保持状态和上下文
5. **Agents** - 让 LLM 自主决定使用什么工具

## LCEL 表达式语言

LCEL（LangChain Expression Language）是 LangChain 的核心编程模型。
它使用管道符 `|` 来组合各种 Runnable 组件，自动获得流式处理、批量处理
和异步处理的能力。

例如：`prompt | llm | parser` 就是一个最简单的 LCEL 链。

## RAG 检索增强生成

RAG 是目前最流行的 LLM 应用模式之一。它的基本流程是：
1. 加载外部文档
2. 将文档分割成小块
3. 对每块生成向量嵌入
4. 用户提问时，检索相关文档块
5. 将检索到的内容和问题一起发给 LLM

这种方式可以让 LLM 基于最新的、特定领域的知识来回答问题，
而不是仅依赖训练数据。
""".strip()


# ───────────────────────────────────────────────────────────────
# 1. RecursiveCharacterTextSplitter（万能首选）
# ───────────────────────────────────────────────────────────────
def demo_recursive_splitter():
    print("══════ 1. RecursiveCharacterTextSplitter ══════")

    from langchain_text_splitters import RecursiveCharacterTextSplitter

    splitter = RecursiveCharacterTextSplitter(
        chunk_size=200,       # 每块最大字符数
        chunk_overlap=30,     # 块之间重叠的字符数（保持上下文连贯）
        separators=["\n\n", "\n", "。", "，", " ", ""],  # 分割优先级
        # ⭐ 先尝试按 \n\n 分割（段落），分不够再用 \n（行），
        #    再用句号、逗号、空格，最后按字符
    )

    chunks = splitter.split_text(SAMPLE_TEXT)

    print(f"  原文长度: {len(SAMPLE_TEXT)} 字符")
    print(f"  分割块数: {len(chunks)}")
    print()
    for i, chunk in enumerate(chunks):
        print(f"  ── 块 {i+1} ({len(chunk)} 字符) ──")
        print(f"  {chunk[:80]}...")
        print()


# ───────────────────────────────────────────────────────────────
# 2. 从 Document 分割
# ───────────────────────────────────────────────────────────────
def demo_split_documents():
    print("══════ 2. 分割 Document 对象 ══════")

    from langchain_core.documents import Document
    from langchain_text_splitters import RecursiveCharacterTextSplitter

    docs = [
        Document(page_content=SAMPLE_TEXT, metadata={"source": "intro.md", "page": 1}),
    ]

    splitter = RecursiveCharacterTextSplitter(chunk_size=200, chunk_overlap=30)

    # ⭐ split_documents 保留并传递 metadata
    split_docs = splitter.split_documents(docs)

    print(f"  原始文档数: {len(docs)}")
    print(f"  分割后文档数: {len(split_docs)}")
    print(f"  第1块 metadata: {split_docs[0].metadata}")
    # metadata 自动继承原文档的，无需手动处理


# ───────────────────────────────────────────────────────────────
# 3. 按代码语言分割
# ───────────────────────────────────────────────────────────────
def demo_code_splitter():
    print("\n══════ 3. 代码分割 ══════")

    from langchain_text_splitters import (
        RecursiveCharacterTextSplitter,
        Language,
    )

    python_code = '''
class Calculator:
    """一个简单的计算器"""

    def __init__(self):
        self.history = []

    def add(self, a, b):
        result = a + b
        self.history.append(f"{a} + {b} = {result}")
        return result

    def multiply(self, a, b):
        result = a * b
        self.history.append(f"{a} * {b} = {result}")
        return result

    def get_history(self):
        return self.history


def main():
    calc = Calculator()
    print(calc.add(1, 2))
    print(calc.multiply(3, 4))
    print(calc.get_history())
'''

    # ⭐ 按 Python 语法结构分割（类、函数为分割边界）
    splitter = RecursiveCharacterTextSplitter.from_language(
        language=Language.PYTHON,
        chunk_size=200,
        chunk_overlap=30,
    )

    chunks = splitter.split_text(python_code)

    print(f"  代码块数: {len(chunks)}")
    for i, chunk in enumerate(chunks):
        print(f"\n  ── 块 {i+1} ──")
        print(f"  {chunk[:100]}...")

    # 支持的语言：
    # Language.PYTHON, Language.JAVASCRIPT, Language.TYPESCRIPT,
    # Language.GO, Language.JAVA, Language.RUST, Language.CPP, ...
    print(f"\n  支持的语言: {[l.value for l in Language][:10]}...")


# ───────────────────────────────────────────────────────────────
# 4. chunk_size 和 chunk_overlap 调优
# ───────────────────────────────────────────────────────────────
def demo_tuning():
    print("\n══════ 4. 分割参数调优 ══════")

    from langchain_text_splitters import RecursiveCharacterTextSplitter

    # 对比不同参数的效果
    configs = [
        (100, 0, "小块无重叠"),
        (100, 20, "小块有重叠"),
        (300, 50, "大块有重叠"),
        (500, 100, "更大块"),
    ]

    for size, overlap, desc in configs:
        splitter = RecursiveCharacterTextSplitter(
            chunk_size=size, chunk_overlap=overlap
        )
        chunks = splitter.split_text(SAMPLE_TEXT)
        avg_len = sum(len(c) for c in chunks) / len(chunks) if chunks else 0
        print(f"  {desc:12s} | size={size:3d} overlap={overlap:3d} | "
              f"块数={len(chunks):2d} 平均长度={avg_len:.0f}")

    tips = """
    ⭐ 调优建议：

    chunk_size：
    - 太小（<100）：语义不完整，检索质量差
    - 太大（>2000）：包含太多无关内容，检索不精确
    - 推荐：300-1000 字符（取决于文档类型）

    chunk_overlap：
    - 0：块之间没有上下文衔接
    - 过大：浪费存储和计算
    - 推荐：chunk_size 的 10-20%

    经验法则：
    - FAQ/短文档：chunk_size=200, overlap=20
    - 技术文档：chunk_size=500, overlap=50
    - 法律/学术：chunk_size=1000, overlap=200
    """
    print(tips)


if __name__ == "__main__":
    demo_recursive_splitter()
    demo_split_documents()
    demo_code_splitter()
    demo_tuning()
