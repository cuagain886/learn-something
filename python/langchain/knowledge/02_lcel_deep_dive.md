# 02 · LCEL 深入 ⭐

> LCEL（LangChain Expression Language）是 LangChain 的声明式编程模型。理解它的底层机制，才能写出高效、可调试的链。

---

## 1. Runnable 的组合原理

### `|` 管道符的本质

```python
chain = prompt | llm | parser
```

Python 中 `|` 是 `__or__` 运算符。LangChain 在 `Runnable` 基类中重载了它：

```python
class Runnable:
    def __or__(self, other):
        return RunnableSequence(first=self, last=other)
    
    def __ror__(self, other):
        # 处理 dict | runnable 的情况
        return RunnableSequence(first=coerce_to_runnable(other), last=self)
```

`RunnableSequence` 的 `invoke` 实现：
```python
class RunnableSequence(Runnable):
    def invoke(self, input, config=None):
        result = input
        for step in self.steps:
            result = step.invoke(result, config)  # 依次传递
        return result
    
    def stream(self, input, config=None):
        # ⭐ 流式传播：最后一个支持 stream 的步骤做流式
        # 前面的步骤用 invoke，最后一步用 stream
        ...
```

### 自动类型转换

LCEL 会自动把某些类型转为 Runnable：

```python
# dict → RunnableParallel
{"key1": chain_a, "key2": chain_b}  →  RunnableParallel(key1=chain_a, key2=chain_b)

# 函数 → RunnableLambda
lambda x: x["key"]  →  RunnableLambda(func)

# 在 pipe 中：
chain = prompt | llm | (lambda msg: msg.content)  # 自动包装
```

---

## 2. 流式传播机制

### stream 在链中如何工作

```python
chain = prompt | llm | parser

for chunk in chain.stream({"question": "..."}):
    print(chunk, end="")
```

内部流程：
```
1. prompt.invoke(input)           → 不流式（模板渲染是一次性的）
2. llm.stream(prompt_result)      → 流式！逐 token 产出 AIMessageChunk
3. parser.stream(each_chunk)      → 转发流式（把 chunk.content 提取出来）
```

⭐ **规则**：链中的每个组件决定自己是否支持流式。支持的组件会接收上游的流并逐块处理，不支持的会等上游完成后再一次性处理。

### 哪些组件支持流式？

| 组件 | stream 支持 | 说明 |
|------|------------|------|
| ChatOpenAI | ✅ | 逐 token 输出 AIMessageChunk |
| StrOutputParser | ✅ | 逐块提取 content |
| JsonOutputParser | ✅ | 逐步解析 JSON（部分解析） |
| ChatPromptTemplate | ❌ | 模板渲染是一次性的 |
| RunnableLambda | 看情况 | 如果函数是生成器则支持 |
| VectorStoreRetriever | ❌ | 检索是一次性的 |

### 让 RunnableLambda 支持流式

```python
from langchain_core.runnables import RunnableLambda

def my_transform(chunks):
    """接收流式输入，产出流式输出"""
    for chunk in chunks:
        yield chunk.upper()   # 对每个 chunk 做处理

# 包装为支持流式的 Runnable
streaming_transform = RunnableLambda(my_transform).with_config(
    run_name="uppercase_transform"
)
```

---

## 3. RunnableParallel 的执行模型

```python
from langchain_core.runnables import RunnableParallel

parallel = RunnableParallel(
    summary=summary_chain,
    translation=translation_chain,
)
```

### invoke 模式
```
输入 → [summary_chain.invoke()]  → 合并 → {"summary": ..., "translation": ...}
     → [translation_chain.invoke()]
```

两个链**并发执行**（使用线程池），不是串行。

### batch 模式
```python
parallel.batch([input1, input2], config={"max_concurrency": 5})
```
每个输入的两个链并发，多个输入也并发，总并发数受 `max_concurrency` 控制。

---

## 4. 自定义 Runnable

### 方式一：RunnableLambda（最简单）

```python
from langchain_core.runnables import RunnableLambda

def preprocess(input_dict: dict) -> dict:
    return {"question": input_dict["question"].strip()}

step = RunnableLambda(preprocess)
```

### 方式二：继承 Runnable（完全控制）

```python
from langchain_core.runnables import Runnable, RunnableConfig
from typing import Optional

class MyCustomRunnable(Runnable[str, str]):
    """自定义 Runnable"""
    
    def invoke(self, input: str, config: Optional[RunnableConfig] = None) -> str:
        return input.upper()
    
    async def ainvoke(self, input: str, config: Optional[RunnableConfig] = None) -> str:
        return input.upper()
```

### 方式三：RunnableGenerator（流式自定义）

```python
from langchain_core.runnables import RunnableGenerator

def streaming_process(chunks):
    buffer = ""
    for chunk in chunks:
        buffer += chunk
        if "。" in buffer:
            sentence, buffer = buffer.split("。", 1)
            yield sentence + "。"
    if buffer:
        yield buffer

step = RunnableGenerator(streaming_process)
```

---

## 5. 调试技巧

### 查看链结构
```python
chain = prompt | llm | parser
print(chain.get_graph().draw_ascii())

# 输出类似：
#     +----------+
#     | prompt   |
#     +----------+
#          |
#     +----------+
#     |   llm    |
#     +----------+
#          |
#     +----------+
#     |  parser  |
#     +----------+
```

### 查看输入输出 Schema
```python
print(chain.input_schema.model_json_schema())
print(chain.output_schema.model_json_schema())
```

### 给链中的步骤命名
```python
chain = (
    prompt.with_config(run_name="format_prompt")
    | llm.with_config(run_name="call_openai")
    | parser.with_config(run_name="parse_output")
)
# 在 LangSmith 追踪中会显示这些名字
```

### astream_events 逐步追踪
```python
async for event in chain.astream_events(input, version="v2"):
    print(f"{event['event']}: {event['name']}")
```

---

## 面试常见问题

**Q1：LCEL 的 `|` 管道符是怎么实现的？**
A：通过重载 `__or__` 运算符，创建 `RunnableSequence`。每个步骤的输出作为下一个步骤的输入。

**Q2：stream 在链中是怎么传播的？**
A：链中最后一个支持 stream 的组件做流式输出，它之前的步骤用 invoke 执行。每个 chunk 会通过后续步骤逐个处理。

**Q3：RunnableParallel 是真并行吗？**
A：invoke 模式下使用线程池并发执行（Python 线程，受 GIL 限制，但 I/O 操作如 API 调用是真并发）。async 模式下使用 asyncio 并发。

---

## 一句话总结

LCEL 的本质是 Runnable 的组合——`|` 创建 RunnableSequence，`{}`/RunnableParallel 并发执行，流式通过 chunk 传播，所有组合自动获得 invoke/stream/batch/async 四种调用方式。
