"""
═══════════════════════════════════════════════════════════════════
 01_quickstart —— LangChain 快速上手
═══════════════════════════════════════════════════════════════════

【本节学什么】
  1. LangChain 是什么、解决什么问题
  2. 安装与环境配置
  3. 第一个 LLM 调用
  4. 第一个 Chain（LCEL 语法）
  5. LangChain 的核心概念全景图

【安装】
  pip install langchain langchain-openai langchain-community
  pip install python-dotenv   # 管理环境变量

  # 如果用 Anthropic：pip install langchain-anthropic
  # 如果用本地模型：pip install langchain-ollama

【环境变量】
  创建 .env 文件：
    OPENAI_API_KEY=sk-xxx
    # 或 ANTHROPIC_API_KEY=sk-ant-xxx

【运行】python main.py

【LangChain 解决什么问题】
  直接调用 OpenAI API 当然可以，但实际项目中你需要：
  - 切换模型（OpenAI → Anthropic → 本地）而不改业务代码
  - 组合多个步骤（提示词模板 → LLM → 输出解析）
  - 接入外部数据（文档、数据库、API）
  - 让 LLM 使用工具（搜索、计算、代码执行）
  - 管理对话历史、流式输出、可观测性
  LangChain 提供了统一抽象层来处理这些需求。

【LangChain v0.3 架构】
  langchain-core    ← 核心抽象（Runnable、PromptTemplate、Message...）
  langchain         ← 通用链、Agent、检索逻辑
  langchain-openai  ← OpenAI 集成（独立包，按需安装）
  langchain-anthropic ← Anthropic 集成
  langchain-community ← 社区集成（各种 loader、vectorstore...）
  langgraph         ← 基于图的 Agent 编排框架
  langsmith         ← 可观测性平台（追踪、评估）
"""
import os
from dotenv import load_dotenv

# 加载 .env 文件中的环境变量（OPENAI_API_KEY 等）
load_dotenv()


# ───────────────────────────────────────────────────────────────
# 1. 最基本的 LLM 调用
# ───────────────────────────────────────────────────────────────
def demo_basic_call():
    """直接调用 ChatModel"""
    print("══════ 1. 基本 LLM 调用 ══════")

    from langchain_openai import ChatOpenAI

    # 创建模型实例
    # ⚠️ 实际项目中 model 名和 temperature 应该可配置
    llm = ChatOpenAI(
        model="deepseek-v4-pro",    # 模型名称
        temperature=0,          # 0=确定性输出，1=随机性最大
        # api_key="sk-xxx",     # 也可以直接传，但推荐用环境变量
    )

    # 最简单的调用：传入字符串
    response = llm.invoke("用一句话解释什么是 LangChain")
    print(f"  类型: {type(response)}")    # AIMessage
    print(f"  内容: {response.content}")
    print(f"  元数据: {response.response_metadata}")

    # ⭐ LangChain 的核心接口：invoke / stream / batch
    # invoke(input)          → 同步调用，返回单个结果
    # stream(input)          → 流式输出，返回迭代器
    # batch([input1, ...])   → 批量调用，返回列表
    # ainvoke / astream / abatch → 异步版本


# ───────────────────────────────────────────────────────────────
# 2. 消息类型
# ───────────────────────────────────────────────────────────────
def demo_messages():
    """LangChain 的消息体系"""
    print("\n══════ 2. 消息类型 ══════")

    from langchain_openai import ChatOpenAI
    from langchain_core.messages import (
        SystemMessage,    # 系统消息：设定角色和行为
        HumanMessage,     # 人类消息：用户输入
        AIMessage,        # AI 消息：模型回复
    )

    llm = ChatOpenAI(model="deepseek-v4-pro", temperature=0)

    # 用消息列表调用（更精确地控制对话）
    messages = [
        SystemMessage(content="你是一个简洁的技术顾问，用中文回答，不超过50字。"),
        HumanMessage(content="Python 和 Go 的最大区别是什么？"),
    ]

    response = llm.invoke(messages)
    print(f"  回复: {response.content}")

    # 多轮对话：手动拼接历史
    messages.append(response)                              # 加入 AI 回复
    messages.append(HumanMessage(content="哪个更适合写后端？"))  # 追问
    response2 = llm.invoke(messages)
    print(f"  追问: {response2.content}")


# ───────────────────────────────────────────────────────────────
# 3. 第一个 Chain（LCEL 语法）
# ───────────────────────────────────────────────────────────────
def demo_first_chain():
    """用 LCEL（LangChain Expression Language）组合链"""
    print("\n══════ 3. 第一个 Chain ══════")

    from langchain_openai import ChatOpenAI
    from langchain_core.prompts import ChatPromptTemplate
    from langchain_core.output_parsers import StrOutputParser

    # 步骤 1：定义提示词模板
    prompt = ChatPromptTemplate.from_messages([
        ("system", "你是一个{role}，用中文回答。"),
        ("human", "{question}"),
    ])

    # 步骤 2：选择模型
    llm = ChatOpenAI(model="deepseek-v4-pro", temperature=0)

    # 步骤 3：定义输出解析器
    parser = StrOutputParser()   # 最简单的：提取 AIMessage.content

    # ⭐ 用 | 管道符组合成链（LCEL 的核心语法）
    chain = prompt | llm | parser
    # 等价于：chain = prompt.pipe(llm).pipe(parser)

    # 调用链
    result = chain.invoke({
        "role": "Python 专家",
        "question": "装饰器的本质是什么？用一句话回答。"
    })
    print(f"  结果: {result}")
    print(f"  类型: {type(result)}")   # str（经过 StrOutputParser）

    # 查看链的结构
    print(f"\n  链的输入 schema: {chain.input_schema.model_json_schema()}")


# ───────────────────────────────────────────────────────────────
# 4. 流式输出
# ───────────────────────────────────────────────────────────────
def demo_streaming():
    """流式输出 —— 用户体验的关键"""
    print("\n══════ 4. 流式输出 ══════")

    from langchain_openai import ChatOpenAI
    from langchain_core.prompts import ChatPromptTemplate
    from langchain_core.output_parsers import StrOutputParser

    chain = (
        ChatPromptTemplate.from_template("用3句话介绍{topic}")
        | ChatOpenAI(model="deepseek-v4-pro", temperature=0)
        | StrOutputParser()
    )

    # stream() 返回生成器，逐 token 输出
    print("  ", end="")
    for chunk in chain.stream({"topic": "LangChain"}):
        print(chunk, end="", flush=True)
    print()


# ───────────────────────────────────────────────────────────────
# 5. 核心概念全景图
# ───────────────────────────────────────────────────────────────
def demo_overview():
    print("\n══════ 5. LangChain 核心概念 ══════")

    overview = """
    ┌─────────────────────────────────────────────────────────────┐
    │                    LangChain 核心概念                        │
    ├─────────────────────────────────────────────────────────────┤
    │                                                             │
    │  Models（模型）                                              │
    │    ChatOpenAI, ChatAnthropic, ChatOllama...                 │
    │    统一接口：invoke / stream / batch                         │
    │                                                             │
    │  Prompts（提示词）                                           │
    │    ChatPromptTemplate, FewShotPromptTemplate...             │
    │    变量插值、消息角色控制                                      │
    │                                                             │
    │  Output Parsers（输出解析）                                   │
    │    StrOutputParser, JsonOutputParser, PydanticOutputParser  │
    │    结构化输出、类型安全                                       │
    │                                                             │
    │  LCEL（表达式语言）                                           │
    │    | 管道符组合 Runnable 组件                                 │
    │    自动支持 stream/batch/async                               │
    │                                                             │
    │  Retrievers（检索器）                                        │
    │    VectorStore, BM25, Ensemble...                           │
    │    连接外部知识 → RAG                                        │
    │                                                             │
    │  Tools & Agents（工具与智能体）                               │
    │    让 LLM 调用外部工具（搜索、计算、API...）                   │
    │    ReAct、Tool-calling Agent                                │
    │                                                             │
    │  LangGraph（图编排）                                         │
    │    基于状态图的 Agent 编排，支持循环和条件分支                   │
    │                                                             │
    │  LangSmith（可观测性）                                       │
    │    追踪、调试、评估、监控                                     │
    │                                                             │
    └─────────────────────────────────────────────────────────────┘
    """
    print(overview)


if __name__ == "__main__":
    demo_basic_call()
    demo_messages()
    demo_first_chain()
    demo_streaming()
    demo_overview()
