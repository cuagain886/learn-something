"""
═══════════════════════════════════════════════════════════════════
 10_rag —— RAG 检索增强生成（完整实战）
═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. RAG 的完整流程（端到端）
 2. 基础 RAG 链的搭建
 3. 带来源引用的 RAG
 4. 对话式 RAG（带历史）
 5. 常见问题与优化方向

【RAG 全景】

  ┌──────── 离线索引阶段（Indexing）────────┐
  │                                         │
  │  文档 → 加载 → 分割 → 嵌入 → 存入向量库   │
  │                                         │
  └─────────────────────────────────────────┘

  ┌──────── 在线查询阶段（Querying）────────┐
  │                                         │
  │  用户提问 → 检索相关文档 → 拼接 prompt    │
  │         → LLM 生成回答 → 返回用户        │
  │                                         │
  └─────────────────────────────────────────┘

【安装】pip install langchain langchain-openai faiss-cpu langchain-community

【运行】python main.py
"""
from dotenv import load_dotenv
load_dotenv()


# ───────────────────────────────────────────────────────────────
# 准备：创建演示知识库
# ───────────────────────────────────────────────────────────────
KNOWLEDGE_BASE = [
    "LangChain 是一个开源的 LLM 应用开发框架，由 Harrison Chase 在 2022 年创建。它的核心目标是让开发者能够更容易地构建基于大语言模型的应用。",
    "LCEL（LangChain Expression Language）是 LangChain 的声明式编程模型。它使用管道符 | 来组合 Runnable 组件，自动支持流式处理、批量处理和异步。每个组件实现 invoke/stream/batch 接口。",
    "RAG（Retrieval-Augmented Generation）是检索增强生成的缩写。它通过检索外部知识库来增强 LLM 的回答，解决了 LLM 知识过时和幻觉的问题。RAG 的核心流程是：检索相关文档 → 注入上下文 → 生成回答。",
    "LangChain 的 Agent 允许 LLM 自主决定使用什么工具。Agent 接收用户输入后，LLM 会推理需要调用哪些工具，执行工具，观察结果，然后决定下一步动作，直到得出最终答案。",
    "LangGraph 是 LangChain 团队开发的 Agent 编排框架。它基于状态图（StateGraph），支持循环、条件分支和人机交互。相比传统 Agent，LangGraph 提供了更可控、更可靠的 Agent 开发方式。",
    "LangSmith 是 LangChain 的可观测性平台。它提供了 LLM 调用的追踪（tracing）、调试、评估和监控功能。通过 LangSmith，你可以看到每个链节点的输入输出、延迟和成本。",
    "向量存储（VectorStore）是存储文本嵌入向量的数据库。常用的有 FAISS（本地）、Chroma（轻量级）、Pinecone（云托管）和 Milvus（大规模）。选择取决于数据量、是否需要持久化和部署方式。",
    "文本分割是 RAG 的关键步骤。RecursiveCharacterTextSplitter 是最常用的分割器，它按优先级尝试不同分隔符（段落→行→句子→字符）来保持语义完整性。推荐 chunk_size 为 500-1000。",
]


def build_knowledge_base():
    """构建向量知识库"""
    from langchain_openai import OpenAIEmbeddings
    from langchain_community.vectorstores import FAISS
    from langchain_core.documents import Document
    from langchain_text_splitters import RecursiveCharacterTextSplitter

    docs = [
        Document(page_content=text, metadata={"source": f"kb_{i+1}", "chunk_id": i})
        for i, text in enumerate(KNOWLEDGE_BASE)
    ]

    splitter = RecursiveCharacterTextSplitter(chunk_size=300, chunk_overlap=50)
    split_docs = splitter.split_documents(docs)

    vectorstore = FAISS.from_documents(
        split_docs,
        OpenAIEmbeddings(model="text-embedding-3-small"),
    )
    return vectorstore


# ───────────────────────────────────────────────────────────────
# 1. 基础 RAG 链
# ───────────────────────────────────────────────────────────────
def demo_basic_rag():
    print("══════ 1. 基础 RAG 链 ══════")

    from langchain_openai import ChatOpenAI
    from langchain_core.prompts import ChatPromptTemplate
    from langchain_core.output_parsers import StrOutputParser
    from langchain_core.runnables import RunnablePassthrough

    vectorstore = build_knowledge_base()
    retriever = vectorstore.as_retriever(search_kwargs={"k": 3})

    # ⭐ RAG 提示词模板
    prompt = ChatPromptTemplate.from_template("""
基于以下参考资料回答问题。如果参考资料中没有相关信息，请如实说明。

参考资料：
{context}

问题：{question}

回答：""")

    # ⭐ 辅助函数：把 Document 列表格式化为字符串
    def format_docs(docs):
        return "\n\n".join(doc.page_content for doc in docs)

    # ⭐ RAG 链的核心结构
    rag_chain = (
        {
            "context": retriever | format_docs,    # 检索 → 格式化
            "question": RunnablePassthrough(),      # 直接透传用户问题
        }
        | prompt
        | ChatOpenAI(model="gpt-4o-mini", temperature=0)
        | StrOutputParser()
    )

    # 测试
    questions = [
        "什么是 LCEL？",
        "RAG 的核心流程是什么？",
        "LangSmith 有什么用？",
    ]

    for q in questions:
        answer = rag_chain.invoke(q)
        print(f"  Q: {q}")
        print(f"  A: {answer[:100]}...")
        print()


# ───────────────────────────────────────────────────────────────
# 2. 带来源引用的 RAG
# ───────────────────────────────────────────────────────────────
def demo_rag_with_sources():
    print("══════ 2. 带来源引用的 RAG ══════")

    from langchain_openai import ChatOpenAI
    from langchain_core.prompts import ChatPromptTemplate
    from langchain_core.output_parsers import StrOutputParser
    from langchain_core.runnables import RunnablePassthrough, RunnableLambda

    vectorstore = build_knowledge_base()
    retriever = vectorstore.as_retriever(search_kwargs={"k": 3})

    prompt = ChatPromptTemplate.from_template("""
基于以下参考资料回答问题。在回答末尾注明引用的来源编号。

参考资料：
{context}

问题：{question}

回答：""")

    def format_docs_with_source(docs):
        formatted = []
        for doc in docs:
            source = doc.metadata.get('source', 'unknown')
            formatted.append(f"[{source}] {doc.page_content}")
        return "\n\n".join(formatted)

    # ⭐ 同时返回答案和检索到的文档
    def retrieve_and_format(question):
        docs = retriever.invoke(question)
        return {
            "context": format_docs_with_source(docs),
            "question": question,
            "source_docs": docs,   # 保留原始文档用于展示
        }

    chain = (
        RunnableLambda(retrieve_and_format)
        | RunnablePassthrough.assign(
            answer=prompt | ChatOpenAI(model="gpt-4o-mini", temperature=0) | StrOutputParser()
        )
    )

    result = chain.invoke("LangGraph 是什么？")
    print(f"  回答: {result['answer'][:150]}...")
    print(f"\n  引用来源:")
    for doc in result['source_docs']:
        print(f"    [{doc.metadata['source']}] {doc.page_content[:50]}...")


# ───────────────────────────────────────────────────────────────
# 3. 对话式 RAG（带历史记忆）
# ───────────────────────────────────────────────────────────────
def demo_conversational_rag():
    print("\n══════ 3. 对话式 RAG ══════")

    from langchain_openai import ChatOpenAI
    from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
    from langchain_core.output_parsers import StrOutputParser
    from langchain_core.runnables import RunnablePassthrough, RunnableLambda
    from langchain_core.messages import HumanMessage, AIMessage
    from langchain.chains.history_aware_retriever import create_history_aware_retriever
    from langchain.chains.combine_documents import create_stuff_documents_chain
    from langchain.chains.retrieval import create_retrieval_chain

    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)
    vectorstore = build_knowledge_base()
    retriever = vectorstore.as_retriever(search_kwargs={"k": 3})

    # 步骤 1：根据对话历史重写查询
    # ⭐ 问题：用户说"它有什么优势？"——"它"是什么？需要结合历史理解
    contextualize_prompt = ChatPromptTemplate.from_messages([
        ("system", "根据对话历史，将用户的最新问题改写为一个独立的、无需上下文就能理解的查询。"),
        MessagesPlaceholder("chat_history"),
        ("human", "{input}"),
    ])

    history_aware_retriever = create_history_aware_retriever(
        llm, retriever, contextualize_prompt
    )

    # 步骤 2：基于检索结果回答
    answer_prompt = ChatPromptTemplate.from_messages([
        ("system", "你是一个有帮助的助手。基于以下参考资料回答问题。\n\n{context}"),
        MessagesPlaceholder("chat_history"),
        ("human", "{input}"),
    ])

    question_answer_chain = create_stuff_documents_chain(llm, answer_prompt)
    rag_chain = create_retrieval_chain(history_aware_retriever, question_answer_chain)

    # 模拟多轮对话
    chat_history = []

    q1 = "什么是 LangGraph？"
    r1 = rag_chain.invoke({"input": q1, "chat_history": chat_history})
    print(f"  Q1: {q1}")
    print(f"  A1: {r1['answer'][:100]}...")

    chat_history.extend([
        HumanMessage(content=q1),
        AIMessage(content=r1["answer"]),
    ])

    # 追问（需要理解"它"指的是 LangGraph）
    q2 = "它和传统 Agent 有什么区别？"
    r2 = rag_chain.invoke({"input": q2, "chat_history": chat_history})
    print(f"\n  Q2: {q2}")
    print(f"  A2: {r2['answer'][:100]}...")


# ───────────────────────────────────────────────────────────────
# 4. RAG 常见问题与优化
# ───────────────────────────────────────────────────────────────
def demo_optimization():
    print("\n══════ 4. RAG 优化方向 ══════")

    tips = """
    ┌──────────────────────────────────────────────────────────┐
    │  问题              原因                优化方向           │
    ├──────────────────────────────────────────────────────────┤
    │  检索不到相关文档    分块太大/太小        调整 chunk_size   │
    │                    查询措辞不佳          MultiQuery       │
    │                    嵌入模型不好          换更好的嵌入模型   │
    │                                                          │
    │  检索到但答案不对    上下文太多太杂        ContextCompression│
    │                    prompt 不好          优化 RAG prompt  │
    │                    模型能力不够          换更好的 LLM      │
    │                                                          │
    │  回答有幻觉         没检索到仍然回答      prompt 加约束    │
    │                    模型自由发挥          temperature=0    │
    │                                                          │
    │  速度太慢           文档太多             预过滤 + 缓存     │
    │                    嵌入计算慢            异步 + 批量       │
    └──────────────────────────────────────────────────────────┘

    ⭐ 高级 RAG 技术：
    1. Hybrid Search：向量检索 + 关键词检索（BM25）
    2. Re-ranking：用交叉编码器对检索结果重新排序
    3. Query Transformation：查询改写、分解、扩展
    4. Hypothetical Document Embeddings (HyDE)
    5. Parent Document Retriever：小块检索，返回大块上下文
    6. Self-RAG：LLM 自己判断是否需要检索
    """
    print(tips)


if __name__ == "__main__":
    demo_basic_rag()
    demo_rag_with_sources()
    demo_conversational_rag()
    demo_optimization()
