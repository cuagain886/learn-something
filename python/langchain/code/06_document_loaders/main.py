"""
═══════════════════════════════════════════════════════════════════
 06_document_loaders —— 文档加载器
═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. Document 对象：LangChain 的文档抽象
 2. 常用文档加载器（文本、PDF、网页、CSV...）
 3. 目录批量加载
 4. 自定义 Loader

【为什么需要文档加载器】
  RAG（检索增强生成）的第一步是把外部数据加载进来。
  不同格式的数据（PDF、网页、数据库、API）需要不同的加载器，
  但加载后都统一为 Document 对象，后续处理（分割、嵌入、检索）完全一致。

【安装】
  pip install langchain-community
  pip install pypdf          # PDF 加载
  pip install beautifulsoup4 # 网页解析
  pip install unstructured   # 通用文档解析

【运行】python main.py
"""
from dotenv import load_dotenv
load_dotenv()


# ───────────────────────────────────────────────────────────────
# 1. Document 对象
# ───────────────────────────────────────────────────────────────
def demo_document():
    print("══════ 1. Document 对象 ══════")

    from langchain_core.documents import Document

    # Document 就两个字段：page_content + metadata
    doc = Document(
        page_content="LangChain 是一个 LLM 应用开发框架。",
        metadata={
            "source": "langchain_docs",
            "page": 1,
            "author": "Harrison Chase",
        }
    )

    print(f"  内容: {doc.page_content}")
    print(f"  元数据: {doc.metadata}")

    # ⭐ metadata 的作用：
    # 1. 追溯来源（文件名、URL、页码）
    # 2. 过滤检索（只搜某个来源的文档）
    # 3. 展示引用（告诉用户答案来自哪里）


# ───────────────────────────────────────────────────────────────
# 2. 文本文件加载
# ───────────────────────────────────────────────────────────────
def demo_text_loader():
    print("\n══════ 2. 文本文件加载 ══════")

    import tempfile, os
    from langchain_community.document_loaders import TextLoader

    # 创建示例文件
    with tempfile.NamedTemporaryFile(mode='w', suffix='.txt',
                                     delete=False, encoding='utf-8') as f:
        f.write("第一行：LangChain 入门\n")
        f.write("第二行：LCEL 表达式语言\n")
        f.write("第三行：RAG 检索增强生成\n")
        tmp_path = f.name

    try:
        loader = TextLoader(tmp_path, encoding='utf-8')
        docs = loader.load()

        print(f"  文档数: {len(docs)}")
        print(f"  内容: {docs[0].page_content[:50]}")
        print(f"  来源: {docs[0].metadata['source']}")
    finally:
        os.unlink(tmp_path)


# ───────────────────────────────────────────────────────────────
# 3. CSV 加载
# ───────────────────────────────────────────────────────────────
def demo_csv_loader():
    print("\n══════ 3. CSV 加载 ══════")

    import tempfile, os
    from langchain_community.document_loaders.csv_loader import CSVLoader

    # 创建示例 CSV
    with tempfile.NamedTemporaryFile(mode='w', suffix='.csv',
                                     delete=False, encoding='utf-8') as f:
        f.write("name,role,experience\n")
        f.write("张三,后端工程师,5年\n")
        f.write("李四,前端工程师,3年\n")
        f.write("王五,数据工程师,7年\n")
        tmp_path = f.name

    try:
        # ⭐ CSV 的每一行会变成一个 Document
        loader = CSVLoader(tmp_path, encoding='utf-8')
        docs = loader.load()

        print(f"  文档数: {len(docs)}")  # 3（每行一个 doc）
        for doc in docs:
            print(f"  [{doc.metadata['row']}] {doc.page_content[:40]}")
    finally:
        os.unlink(tmp_path)


# ───────────────────────────────────────────────────────────────
# 4. PDF 加载
# ───────────────────────────────────────────────────────────────
def demo_pdf_loader():
    print("\n══════ 4. PDF 加载（示意） ══════")

    info = """
    from langchain_community.document_loaders import PyPDFLoader

    # 每页一个 Document
    loader = PyPDFLoader("report.pdf")
    pages = loader.load()

    print(f"总页数: {len(pages)}")
    print(f"第1页: {pages[0].page_content[:100]}")
    print(f"元数据: {pages[0].metadata}")
    # metadata 包含 {'source': 'report.pdf', 'page': 0}

    # 懒加载（大文件友好）
    for page in loader.lazy_load():
        process(page)

    # 其他 PDF Loader：
    # PyMuPDFLoader     → 更快，支持图片提取
    # UnstructuredPDFLoader → 更智能的结构化解析
    """
    print(info)


# ───────────────────────────────────────────────────────────────
# 5. 网页加载
# ───────────────────────────────────────────────────────────────
def demo_web_loader():
    print("══════ 5. 网页加载（示意） ══════")

    info = """
    from langchain_community.document_loaders import WebBaseLoader

    loader = WebBaseLoader("https://python.langchain.com/docs/introduction/")
    docs = loader.load()

    print(f"  内容长度: {len(docs[0].page_content)}")
    print(f"  来源: {docs[0].metadata['source']}")

    # 批量加载多个 URL
    loader = WebBaseLoader([
        "https://example.com/page1",
        "https://example.com/page2",
    ])
    docs = loader.load()  # 自动并发加载
    """
    print(info)


# ───────────────────────────────────────────────────────────────
# 6. 目录批量加载
# ───────────────────────────────────────────────────────────────
def demo_directory_loader():
    print("══════ 6. 目录批量加载（示意） ══════")

    info = """
    from langchain_community.document_loaders import DirectoryLoader, TextLoader

    # 加载目录下所有 .txt 文件
    loader = DirectoryLoader(
        "./documents",
        glob="**/*.txt",                    # 文件匹配模式
        loader_cls=TextLoader,              # 使用什么 Loader
        loader_kwargs={"encoding": "utf-8"},
        show_progress=True,                 # 显示进度条
        use_multithreading=True,            # 多线程加载
    )
    docs = loader.load()

    # 常见的 glob 模式：
    # "**/*.pdf"    → 所有 PDF
    # "**/*.md"     → 所有 Markdown
    # "*.txt"       → 当前目录的 txt（不递归）
    """
    print(info)


# ───────────────────────────────────────────────────────────────
# 7. 自定义 Loader
# ───────────────────────────────────────────────────────────────
def demo_custom_loader():
    print("══════ 7. 自定义 Loader ══════")

    from langchain_core.documents import Document
    from langchain_core.document_loaders import BaseLoader
    from typing import Iterator

    class JsonlLoader(BaseLoader):
        """自定义：加载 JSONL 文件，每行一个 Document"""

        def __init__(self, file_path: str):
            self.file_path = file_path

        def lazy_load(self) -> Iterator[Document]:
            """⭐ 实现 lazy_load 即可（推荐用生成器）"""
            import json
            with open(self.file_path, 'r', encoding='utf-8') as f:
                for i, line in enumerate(f):
                    data = json.loads(line)
                    yield Document(
                        page_content=data.get("text", ""),
                        metadata={
                            "source": self.file_path,
                            "line": i,
                            **{k: v for k, v in data.items() if k != "text"},
                        }
                    )

    # 演示
    import tempfile, os, json
    with tempfile.NamedTemporaryFile(mode='w', suffix='.jsonl',
                                     delete=False, encoding='utf-8') as f:
        for item in [
            {"text": "LangChain 入门", "tag": "tutorial"},
            {"text": "RAG 最佳实践", "tag": "advanced"},
        ]:
            f.write(json.dumps(item, ensure_ascii=False) + "\n")
        tmp_path = f.name

    try:
        loader = JsonlLoader(tmp_path)
        docs = list(loader.lazy_load())

        for doc in docs:
            print(f"  [{doc.metadata['tag']}] {doc.page_content}")
    finally:
        os.unlink(tmp_path)


# ───────────────────────────────────────────────────────────────
# 8. 加载器全景
# ───────────────────────────────────────────────────────────────
def demo_overview():
    print("\n══════ 8. 常用加载器速查 ══════")
    overview = """
    ┌──────────────────────────────────────────────────────────┐
    │  数据源          加载器                    安装            │
    ├──────────────────────────────────────────────────────────┤
    │  纯文本          TextLoader                内置           │
    │  CSV             CSVLoader                 内置           │
    │  JSON            JSONLoader                内置           │
    │  PDF             PyPDFLoader               pypdf          │
    │  Word            Docx2txtLoader            docx2txt       │
    │  网页            WebBaseLoader             beautifulsoup4 │
    │  HTML 文件       BSHTMLLoader              beautifulsoup4 │
    │  Markdown        UnstructuredMarkdownLoader unstructured  │
    │  Notion          NotionDirectoryLoader     内置           │
    │  GitHub          GitHubIssuesLoader        内置           │
    │  数据库          SQLDatabaseLoader         sqlalchemy     │
    │  S3              S3FileLoader              boto3          │
    │  YouTube         YoutubeLoader             youtube-*      │
    └──────────────────────────────────────────────────────────┘

    ⭐ 所有 Loader 的输出都是 List[Document]
       后续处理（分割 → 嵌入 → 检索）完全统一
    """
    print(overview)


if __name__ == "__main__":
    demo_document()
    demo_text_loader()
    demo_csv_loader()
    demo_pdf_loader()
    demo_web_loader()
    demo_directory_loader()
    demo_custom_loader()
    demo_overview()
