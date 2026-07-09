"""
═══════════════════════════════════════════════════════════════════
 08_embeddings_vectorstores —— 嵌入与向量存储
═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. 什么是文本嵌入（Embedding）
 2. 嵌入模型的使用
 3. 向量存储（VectorStore）
 4. 相似度搜索
 5. 常用向量数据库对比

【核心概念】
  嵌入（Embedding）：把文本转换为高维向量（浮点数列表）。
  语义相似的文本，向量距离就近。

  文本 → [0.12, -0.34, 0.56, ...] （通常 768-3072 维）

  有了向量，就可以用数学方法（余弦相似度、欧氏距离）衡量文本相似度，
  这是 RAG 检索的数学基础。

【安装】
  pip install langchain-openai     # OpenAI 嵌入
  pip install faiss-cpu            # Facebook 的向量搜索（CPU 版）
  pip install chromadb             # Chroma 向量数据库

【运行】python main.py
"""
from dotenv import load_dotenv
load_dotenv()


# ───────────────────────────────────────────────────────────────
# 1. 嵌入模型基础
# ───────────────────────────────────────────────────────────────
def demo_embeddings():
    print("══════ 1. 嵌入模型 ══════")

    from langchain_openai import OpenAIEmbeddings

    embeddings = OpenAIEmbeddings(
        model="text-embedding-3-small",   # 推荐：便宜且效果好
        # model="text-embedding-3-large", # 更高精度
    )

    # 嵌入单个文本
    vector = embeddings.embed_query("什么是 LangChain？")
    print(f"  向量维度: {len(vector)}")
    print(f"  前5个值: {vector[:5]}")

    # 嵌入多个文档（batch）
    texts = ["LangChain 是一个框架", "Python 是一门语言", "今天天气不错"]
    vectors = embeddings.embed_documents(texts)
    print(f"  文档数: {len(vectors)}")
    print(f"  每个向量维度: {len(vectors[0])}")

    # ⭐ embed_query vs embed_documents
    # query：用于用户查询（有些模型对 query 和 doc 有不同处理）
    # documents：用于文档入库


# ───────────────────────────────────────────────────────────────
# 2. 计算相似度
# ───────────────────────────────────────────────────────────────
def demo_similarity():
    print("\n══════ 2. 手动计算相似度 ══════")

    from langchain_openai import OpenAIEmbeddings
    import numpy as np

    embeddings = OpenAIEmbeddings(model="text-embedding-3-small")

    texts = [
        "Python 是一门编程语言",
        "Java 也是一门编程语言",
        "今天去公园散步",
    ]
    query = "什么编程语言最好？"

    # 计算嵌入
    doc_vectors = embeddings.embed_documents(texts)
    query_vector = embeddings.embed_query(query)

    # 余弦相似度
    def cosine_similarity(a, b):
        a, b = np.array(a), np.array(b)
        return np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b))

    for text, vec in zip(texts, doc_vectors):
        sim = cosine_similarity(query_vector, vec)
        print(f"  相似度 {sim:.4f} | {text}")

    # ⭐ 编程语言相关的文本和查询相似度更高，和"散步"的很低
    # 这就是向量检索的基础


# ───────────────────────────────────────────────────────────────
# 3. FAISS 向量存储
# ───────────────────────────────────────────────────────────────
def demo_faiss():
    print("\n══════ 3. FAISS 向量存储 ══════")

    from langchain_openai import OpenAIEmbeddings
    from langchain_community.vectorstores import FAISS
    from langchain_core.documents import Document

    embeddings = OpenAIEmbeddings(model="text-embedding-3-small")

    # 准备文档
    docs = [
        Document(page_content="LangChain 是一个 LLM 应用开发框架", metadata={"topic": "框架"}),
        Document(page_content="LCEL 使用管道符组合 Runnable 组件", metadata={"topic": "LCEL"}),
        Document(page_content="RAG 通过检索外部文档增强 LLM 回答", metadata={"topic": "RAG"}),
        Document(page_content="Agent 可以让 LLM 自主使用工具", metadata={"topic": "Agent"}),
        Document(page_content="Python 是最流行的 AI 编程语言", metadata={"topic": "Python"}),
        Document(page_content="向量数据库存储文本的嵌入向量", metadata={"topic": "向量库"}),
    ]

    # ⭐ 一行代码创建向量存储
    vectorstore = FAISS.from_documents(docs, embeddings)

    # 相似度搜索
    results = vectorstore.similarity_search("什么是 RAG？", k=3)
    print(f"  搜索 '什么是 RAG？' 的 top-3 结果：")
    for doc in results:
        print(f"    [{doc.metadata['topic']}] {doc.page_content}")

    # 带分数的搜索
    results_with_scores = vectorstore.similarity_search_with_score("LCEL 怎么用？", k=2)
    print(f"\n  带分数的搜索（分数越低越相似）：")
    for doc, score in results_with_scores:
        print(f"    分数={score:.4f} | {doc.page_content}")

    # 保存和加载（持久化）
    vectorstore.save_local("./faiss_demo_index")
    print("\n  ✓ 已保存到 ./faiss_demo_index")

    # 重新加载
    loaded_vs = FAISS.load_local(
        "./faiss_demo_index", embeddings,
        allow_dangerous_deserialization=True
    )
    print("  ✓ 已重新加载")

    # 清理
    import shutil
    shutil.rmtree("./faiss_demo_index", ignore_errors=True)


# ───────────────────────────────────────────────────────────────
# 4. Chroma 向量存储
# ───────────────────────────────────────────────────────────────
def demo_chroma():
    print("\n══════ 4. Chroma 向量数据库（示意） ══════")

    info = """
    from langchain_chroma import Chroma
    from langchain_openai import OpenAIEmbeddings

    # 内存模式（开发用）
    vectorstore = Chroma.from_documents(docs, OpenAIEmbeddings())

    # 持久化模式
    vectorstore = Chroma.from_documents(
        docs,
        OpenAIEmbeddings(),
        persist_directory="./chroma_db",   # 数据保存目录
        collection_name="my_docs",         # 集合名称
    )

    # 搜索
    results = vectorstore.similarity_search("查询", k=5)

    # ⭐ Chroma 的优势：
    # - 内置持久化，不需要手动保存/加载
    # - 支持元数据过滤
    # - 支持增量添加文档
    # - 支持删除文档

    # 元数据过滤搜索
    results = vectorstore.similarity_search(
        "查询",
        k=5,
        filter={"topic": "RAG"},   # 只搜索特定 topic 的文档
    )

    # 增量添加
    vectorstore.add_documents([new_doc1, new_doc2])
    """
    print(info)


# ───────────────────────────────────────────────────────────────
# 5. 向量数据库对比
# ───────────────────────────────────────────────────────────────
def demo_comparison():
    print("══════ 5. 向量数据库对比 ══════")

    comparison = """
    ┌──────────────────────────────────────────────────────────────┐
    │  数据库      类型       适用场景              部署方式        │
    ├──────────────────────────────────────────────────────────────┤
    │  FAISS       库        大规模检索、研究        嵌入式         │
    │  Chroma      库/服务   原型开发、中小规模      嵌入/独立部署   │
    │  Pinecone    服务      生产环境、免运维        全托管云       │
    │  Weaviate    服务      多模态、GraphQL API    自建/云        │
    │  Milvus      服务      超大规模、高性能        自建/Zilliz   │
    │  Qdrant      服务      过滤搜索、推荐系统      自建/云        │
    │  pgvector    插件      已有 PostgreSQL        数据库插件      │
    └──────────────────────────────────────────────────────────────┘

    ⭐ 选择建议：
    - 原型 / 学习 → Chroma（最简单）
    - 本地大规模 → FAISS（最快）
    - 生产部署 → Pinecone / Qdrant / Milvus
    - 已有 PG → pgvector（最省事）
    """
    print(comparison)


if __name__ == "__main__":
    demo_embeddings()
    demo_similarity()
    demo_faiss()
    demo_chroma()
    demo_comparison()
