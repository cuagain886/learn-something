# 01 · LangChain 架构与设计理念 ⭐

> 理解 LangChain 的分层设计和组件关系，是高效使用它的前提。

---

## 1. 分层架构

```
┌─────────────────────────────────────────────────────┐
│                    应用层                             │
│   你的代码（RAG 应用、Agent、Chatbot...）              │
├─────────────────────────────────────────────────────┤
│                 langchain                            │
│   通用链、Agent 逻辑、检索策略                        │
│   create_retrieval_chain, create_react_agent...      │
├─────────────────────────────────────────────────────┤
│              langchain-core                          │
│   核心抽象（Runnable、Message、Prompt、Document...）  │
│   LCEL 管道组合、回调系统、序列化                      │
├─────────────┬──────────────┬────────────────────────┤
│ langchain-  │ langchain-   │ langchain-             │
│ openai      │ anthropic    │ community              │
│ OpenAI 集成 │ Anthropic 集成│ 社区集成（200+）        │
├─────────────┴──────────────┴────────────────────────┤
│              langgraph                               │
│   图编排框架（StateGraph、Checkpoint、子图...）        │
├─────────────────────────────────────────────────────┤
│              langsmith                               │
│   可观测性（追踪、评估、监控、Playground）             │
└─────────────────────────────────────────────────────┘
```

### 设计原则

1. **核心最小化**：`langchain-core` 只包含抽象接口，不依赖任何 LLM 厂商
2. **集成独立**：每个 LLM 厂商是独立的包（`langchain-openai`、`langchain-anthropic`）
3. **统一接口**：所有组件实现 `Runnable` 协议，可互换、可组合
4. **渐进复杂**：简单场景用 LCEL 链，复杂场景用 LangGraph

---

## 2. Runnable 协议：万物基石

LangChain 的核心抽象是 `Runnable`。所有可组合的组件都实现这个接口：

```python
class Runnable(ABC):
    def invoke(self, input, config=None) -> output:
        """同步调用"""
    
    def stream(self, input, config=None) -> Iterator[chunk]:
        """流式输出"""
    
    def batch(self, inputs, config=None) -> list[output]:
        """批量调用"""
    
    async def ainvoke(self, input, config=None) -> output:
        """异步调用"""
    
    async def astream(self, input, config=None) -> AsyncIterator[chunk]:
        """异步流式"""
    
    async def abatch(self, inputs, config=None) -> list[output]:
        """异步批量"""
    
    def pipe(self, other) -> RunnableSequence:
        """组合：self | other"""
    
    def bind(self, **kwargs) -> RunnableBinding:
        """绑定默认参数"""
    
    @property
    def input_schema(self) -> Type[BaseModel]:
        """输入的 Pydantic schema"""
    
    @property
    def output_schema(self) -> Type[BaseModel]:
        """输出的 Pydantic schema"""
```

### 谁是 Runnable？

| 组件 | 输入类型 | 输出类型 |
|------|---------|---------|
| ChatPromptTemplate | dict | ChatPromptValue |
| ChatOpenAI | Messages / str | AIMessage |
| StrOutputParser | AIMessage | str |
| JsonOutputParser | AIMessage | dict |
| VectorStoreRetriever | str | List[Document] |
| RunnableLambda | Any | Any |
| RunnableSequence (chain) | 第一个组件的输入 | 最后一个组件的输出 |

### ⭐ 关键理解

`|` 管道符创建的是 `RunnableSequence`，它本身也是 `Runnable`。这意味着：
- **组合出的链自动支持 stream/batch/async**
- **链可以继续组合**：`(chain_a | chain_b) | chain_c`
- **可以用 `.get_graph()` 查看结构**

---

## 3. 数据流模型

```python
chain = prompt | llm | parser
result = chain.invoke({"question": "什么是 LCEL？"})
```

数据流：
```
{"question": "什么是 LCEL？"}
    ↓ prompt.invoke()
ChatPromptValue([SystemMessage, HumanMessage])
    ↓ llm.invoke()
AIMessage(content="LCEL 是...")
    ↓ parser.invoke()
"LCEL 是..."  (str)
```

⭐ 每个组件的输出类型必须匹配下一个组件的输入类型，否则运行时报错。

---

## 4. Config 与回调系统

所有 Runnable 方法都接受 `config` 参数：

```python
config = {
    "callbacks": [MyCallback()],      # 回调处理器
    "tags": ["production", "rag"],    # 标签（用于 LangSmith 过滤）
    "metadata": {"user_id": "123"},   # 元数据
    "configurable": {                  # 可配置参数
        "session_id": "abc",           # 会话 ID
    },
    "max_concurrency": 5,             # 最大并发数（batch 时）
}

result = chain.invoke(input, config=config)
```

回调事件生命周期：
```
on_chain_start → on_llm_start → on_llm_new_token(×N) → on_llm_end → on_chain_end
                                      ↑ 流式时触发
```

---

## 5. 版本演进（v0.1 → v0.3）

| 版本 | 变化 | 影响 |
|------|------|------|
| v0.1 | 初始版本，LLMChain、ConversationChain | 已废弃 |
| v0.2 | LCEL 成为核心，with_structured_output | 推荐升级 |
| v0.3 | Pydantic v2、Python 3.9+、清理废弃 API | 当前稳定版 |

⚠️ 常见的过时代码：
```python
# ❌ 旧版（v0.1）
from langchain.llms import OpenAI
from langchain.chains import LLMChain
chain = LLMChain(llm=llm, prompt=prompt)
result = chain.run("question")

# ✅ 新版（v0.3）
from langchain_openai import ChatOpenAI
chain = prompt | llm | parser
result = chain.invoke({"question": "..."})
```

---

## 面试常见问题

**Q1：LangChain 的核心抽象是什么？**
A：Runnable 协议。所有组件（Prompt、Model、Parser、Retriever）都实现 Runnable 接口（invoke/stream/batch），可以用 `|` 管道符自由组合。

**Q2：langchain-core 和 langchain 的区别？**
A：`langchain-core` 只有接口抽象（Runnable、Message、Document...），不依赖任何 LLM 厂商。`langchain` 在 core 之上提供通用的链和 Agent 逻辑（如 create_retrieval_chain）。

**Q3：LCEL 相比旧版 Chain 的优势？**
A：1) 自动支持 stream/batch/async；2) 类型安全（input/output schema）；3) 可视化（get_graph）；4) 更灵活的组合方式。

---

## 一句话总结

LangChain 的核心是 Runnable 协议——一切皆 Runnable，用 `|` 自由组合，自动获得流式、批量、异步能力。
