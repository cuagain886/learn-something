"""
═══════════════════════════════════════════════════════════════════
 09_retrievers —— 检索器
═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. Retriever 接口
 2. 从 VectorStore 创建 Retriever
 3. 多查询检索（MultiQueryRetriever）
 4. 上下文压缩检索（ContextualCompressionRetriever）
 5. 混合检索（Ensemble：向量 + 关键词）
 6. 自定义 Retriever

【Retriever 在 RAG 中的位置】
  文档 → 分割 → 嵌入 → 向量存储 → 【检索器】 → LLM 回答
                                        ↑
                                    你在这里

  检索器决定了"给 LLM 看哪些文档"，直接影响回答质量。

【运行】python main.py
"""
from dotenv import load_dotenv
load_dotenv()

from langchain_core.documents import Document

SAMPLE_DOCS = [
    Document(page_content="LangChain 是一个用于构建 LLM 应用的 Python 框架", metadata={"source": "intro"}),
    Document(page_content="LCEL 使用管道符 | 将 Runnable 组件组合成链", metadata={"source": "lcel"}),
    Document(page_content="RAG 通过检索外部文档来增强 LLM 的回答能力", metadata={"source": "rag"}),
    Document(page_content="Agent 可以让 LLM 自主选择工具来完成任务", metadata={"source": "agent"}),
    Document(page_content="向量数据库通过余弦相似度来找到语义最接近的文档", metadata={"source": "vector"}),
    Document(page_content="文本分割器将长文档切成适合嵌入的小块", metadata={"source": "splitter"}),
    Document(page_content="提示词模板用变量插值来动态生成提示词", metadata={"source": "prompt"}),
    Document(page_content="LangSmith 提供了 LLM 应用的追踪和调试功能", metadata={"source": "langsmith"}),
]


def get_vectorstore():
    """创建演示用的向量存储"""
    from langchain_openai import OpenAIEmbeddings
    from langchain_community.vectorstores import FAISS
    return FAISS.from_documents(SAMPLE_DOCS, OpenAIEmbeddings(model="text-embedding-3-small"))


# ───────────────────────────────────────────────────────────────
# 1. 基本 Retriever
# ───────────────────────────────────────────────────────────────
def demo_basic_retriever():
    print("══════ 1. 基本 Retriever ══════")

    vectorstore = get_vectorstore()

    # ⭐ as_retriever() 把 VectorStore 转成 Retriever
    retriever = vectorstore.as_retriever(
        search_type="similarity",   # 相似度搜索（默认）
        search_kwargs={"k": 3},     # 返回 top-3
    )

    # Retriever 实现了 Runnable 接口，可以用 invoke
    docs = retriever.invoke("什么是 RAG？")

    print(f"  检索到 {len(docs)} 个文档：")
    for doc in docs:
        print(f"    [{doc.metadata['source']}] {doc.page_content[:50]}")

    # search_type 选项：
    # "similarity"     → 纯相似度
    # "mmr"           → 最大边际相关性（兼顾相似度和多样性）
    # "similarity_score_threshold" → 设置最低分数阈值

    # MMR 检索：减少重复结果
    mmr_retriever = vectorstore.as_retriever(
        search_type="mmr",
        search_kwargs={"k": 3, "fetch_k": 10},  # 先取10个再从中选3个多样性最大的
    )

    docs = mmr_retriever.invoke("LangChain 的组件有哪些？")
    print(f"\n  MMR 检索结果：")
    for doc in docs:
        print(f"    [{doc.metadata['source']}] {doc.page_content[:50]}")


# ───────────────────────────────────────────────────────────────
# 2. MultiQueryRetriever（多查询检索）
# ───────────────────────────────────────────────────────────────
def demo_multi_query():
    print("\n══════ 2. MultiQueryRetriever ══════")

    from langchain.retrievers.multi_query import MultiQueryRetriever
    from langchain_openai import ChatOpenAI

    vectorstore = get_vectorstore()

    # ⭐ 用 LLM 把一个查询扩展成多个不同角度的查询
    # 然后分别检索，合并去重结果
    # 解决问题：用户的查询可能措辞不佳，换个说法可能检索到更好的结果
    retriever = MultiQueryRetriever.from_llm(
        retriever=vectorstore.as_retriever(search_kwargs={"k": 3}),
        llm=ChatOpenAI(model="gpt-4o-mini", temperature=0),
    )

    docs = retriever.invoke("LangChain 怎么和外部数据结合？")

    print(f"  检索到 {len(docs)} 个文档（去重后）：")
    for doc in docs:
        print(f"    [{doc.metadata['source']}] {doc.page_content[:50]}")


# ───────────────────────────────────────────────────────────────
# 3. ContextualCompressionRetriever（上下文压缩）
# ───────────────────────────────────────────────────────────────
def demo_compression():
    print("\n══════ 3. 上下文压缩检索（示意） ══════")

    info = """
    from langchain.retrievers import ContextualCompressionRetriever
    from langchain.retrievers.document_compressors import LLMChainExtractor
    from langchain_openai import ChatOpenAI

    # 基础检索器
    base_retriever = vectorstore.as_retriever(search_kwargs={"k": 5})

    # ⭐ 压缩器：用 LLM 从检索到的文档中提取和查询最相关的部分
    compressor = LLMChainExtractor.from_llm(ChatOpenAI(temperature=0))

    compression_retriever = ContextualCompressionRetriever(
        base_compressor=compressor,
        base_retriever=base_retriever,
    )

    # 检索到的文档会被 LLM 精炼，只保留和查询相关的片段
    docs = compression_retriever.invoke("RAG 的工作流程是什么？")

    # 适用场景：
    # - 文档块比较大，包含很多无关内容
    # - 需要从长段落中提取关键信息
    # ⚠️ 代价：每次检索都要调用 LLM，速度变慢、成本增加
    """
    print(info)


# ───────────────────────────────────────────────────────────────
# 4. 自定义 Retriever
# ───────────────────────────────────────────────────────────────
def demo_custom_retriever():
    print("══════ 4. 自定义 Retriever ══════")

    from langchain_core.retrievers import BaseRetriever
    from langchain_core.callbacks import CallbackManagerForRetrieverRun
    from typing import List

    class KeywordRetriever(BaseRetriever):
        """基于关键词匹配的简单检索器"""
        documents: List[Document]

        def _get_relevant_documents(
            self,
            query: str,
            *,
            run_manager: CallbackManagerForRetrieverRun,
        ) -> List[Document]:
            """⭐ 只需实现这一个方法"""
            keywords = query.lower().split()
            scored = []
            for doc in self.documents:
                score = sum(
                    1 for kw in keywords
                    if kw in doc.page_content.lower()
                )
                if score > 0:
                    scored.append((doc, score))

            scored.sort(key=lambda x: x[1], reverse=True)
            return [doc for doc, _ in scored[:3]]

    retriever = KeywordRetriever(documents=SAMPLE_DOCS)
    docs = retriever.invoke("RAG 检索 文档")

    print(f"  关键词检索结果：")
    for doc in docs:
        print(f"    [{doc.metadata['source']}] {doc.page_content[:50]}")


# ───────────────────────────────────────────────────────────────
# 5. 检索策略对比
# ───────────────────────────────────────────────────────────────
def demo_comparison():
    print("\n══════ 5. 检索策略选择 ══════")

    comparison = """
    ┌──────────────────────────────────────────────────────────┐
    │  策略                 优点              缺点              │
    ├──────────────────────────────────────────────────────────┤
    │  Similarity          简单快速          可能错过相关内容    │
    │  MMR                 结果多样性好       略慢              │
    │  MultiQuery          覆盖面广          额外 LLM 调用      │
    │  Compression         结果精准          慢、贵             │
    │  Ensemble            综合效果好        配置复杂           │
    │  Self-Query          支持元数据过滤     需要 LLM 理解 schema│
    └──────────────────────────────────────────────────────────┘

    ⭐ 推荐路线：
    1. 先用 similarity（基线）
    2. 结果有重复 → 换 MMR
    3. 查询措辞问题 → 加 MultiQuery
    4. 需要元数据过滤 → Self-Query
    5. 终极方案 → Ensemble（向量 + BM25）
    """
    print(comparison)


if __name__ == "__main__":
    demo_basic_retriever()
    demo_multi_query()
    demo_compression()
    demo_custom_retriever()
    demo_comparison()
