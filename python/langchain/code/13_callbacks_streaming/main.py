"""
═══════════════════════════════════════════════════════════════════
 13_callbacks_streaming —— 回调与流式输出
═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. 回调系统（Callbacks）
 2. 自定义回调处理器
 3. 流式输出（Streaming）的各种方式
 4. 异步流式（astream_events）
 5. 生产环境的流式方案

【为什么需要回调和流式】
  - 回调：监控、日志、计费、调试（"每次 LLM 调用花了多少 token？"）
  - 流式：用户体验（不用等整个回答生成完，逐 token 显示）

【运行】python main.py
"""
from dotenv import load_dotenv
load_dotenv()


# ───────────────────────────────────────────────────────────────
# 1. 自定义回调处理器
# ───────────────────────────────────────────────────────────────
def demo_custom_callback():
    print("══════ 1. 自定义回调 ══════")

    from langchain_openai import ChatOpenAI
    from langchain_core.prompts import ChatPromptTemplate
    from langchain_core.output_parsers import StrOutputParser
    from langchain_core.callbacks import BaseCallbackHandler
    from datetime import datetime

    class TimingCallback(BaseCallbackHandler):
        """计时回调：记录每次 LLM 调用耗时"""

        def on_llm_start(self, serialized, prompts, **kwargs):
            self.start_time = datetime.now()
            print(f"  [回调] LLM 开始调用...")

        def on_llm_end(self, response, **kwargs):
            elapsed = (datetime.now() - self.start_time).total_seconds()
            print(f"  [回调] LLM 调用完成，耗时 {elapsed:.2f}s")

        def on_chain_start(self, serialized, inputs, **kwargs):
            name = serialized.get("name", "unknown")
            print(f"  [回调] Chain 开始: {name}")

        def on_chain_end(self, outputs, **kwargs):
            print(f"  [回调] Chain 结束")

    chain = (
        ChatPromptTemplate.from_template("用一句话解释 {concept}")
        | ChatOpenAI(model="gpt-4o-mini", temperature=0)
        | StrOutputParser()
    )

    # ⭐ 通过 config 传入回调
    result = chain.invoke(
        {"concept": "微服务"},
        config={"callbacks": [TimingCallback()]}
    )
    print(f"  结果: {result}")


# ───────────────────────────────────────────────────────────────
# 2. Token 计数回调
# ───────────────────────────────────────────────────────────────
def demo_token_counting():
    print("\n══════ 2. Token 计数 ══════")

    from langchain_openai import ChatOpenAI
    from langchain_core.prompts import ChatPromptTemplate
    from langchain_core.output_parsers import StrOutputParser
    from langchain_core.callbacks import BaseCallbackHandler

    class TokenCounter(BaseCallbackHandler):
        """统计 token 使用量"""

        def __init__(self):
            self.total_input_tokens = 0
            self.total_output_tokens = 0

        def on_llm_end(self, response, **kwargs):
            if hasattr(response, 'llm_output') and response.llm_output:
                usage = response.llm_output.get('token_usage', {})
                self.total_input_tokens += usage.get('prompt_tokens', 0)
                self.total_output_tokens += usage.get('completion_tokens', 0)

    counter = TokenCounter()

    chain = (
        ChatPromptTemplate.from_template("用50字介绍 {topic}")
        | ChatOpenAI(model="gpt-4o-mini", temperature=0)
        | StrOutputParser()
    )

    # 调用两次
    chain.invoke({"topic": "Python"}, config={"callbacks": [counter]})
    chain.invoke({"topic": "Go"}, config={"callbacks": [counter]})

    print(f"  总输入 tokens: {counter.total_input_tokens}")
    print(f"  总输出 tokens: {counter.total_output_tokens}")
    print(f"  总计: {counter.total_input_tokens + counter.total_output_tokens}")


# ───────────────────────────────────────────────────────────────
# 3. 基础流式输出
# ───────────────────────────────────────────────────────────────
def demo_basic_streaming():
    print("\n══════ 3. 基础流式输出 ══════")

    from langchain_openai import ChatOpenAI
    from langchain_core.prompts import ChatPromptTemplate
    from langchain_core.output_parsers import StrOutputParser

    chain = (
        ChatPromptTemplate.from_template("用3句话介绍 {topic}")
        | ChatOpenAI(model="gpt-4o-mini", temperature=0)
        | StrOutputParser()
    )

    # ⭐ stream()：逐 token 输出
    print("  ", end="")
    for chunk in chain.stream({"topic": "LangChain 的流式输出"}):
        print(chunk, end="", flush=True)
    print()


# ───────────────────────────────────────────────────────────────
# 4. 流式回调（逐 token 回调）
# ───────────────────────────────────────────────────────────────
def demo_streaming_callback():
    print("\n══════ 4. 流式回调 ══════")

    from langchain_openai import ChatOpenAI
    from langchain_core.prompts import ChatPromptTemplate
    from langchain_core.output_parsers import StrOutputParser
    from langchain_core.callbacks import BaseCallbackHandler

    class StreamingPrinter(BaseCallbackHandler):
        """流式打印回调——每收到一个 token 就调用"""

        def on_llm_new_token(self, token: str, **kwargs):
            print(token, end="", flush=True)

    chain = (
        ChatPromptTemplate.from_template("用2句话解释 {concept}")
        | ChatOpenAI(model="gpt-4o-mini", temperature=0, streaming=True)
        | StrOutputParser()
    )

    # ⭐ 通过回调实现流式（和 stream() 不同，这是推模式）
    print("  ", end="")
    result = chain.invoke(
        {"concept": "事件循环"},
        config={"callbacks": [StreamingPrinter()]}
    )
    print()


# ───────────────────────────────────────────────────────────────
# 5. astream_events（异步事件流）
# ───────────────────────────────────────────────────────────────
def demo_astream_events():
    print("\n══════ 5. astream_events（示意） ══════")

    info = """
    import asyncio
    from langchain_openai import ChatOpenAI
    from langchain_core.prompts import ChatPromptTemplate
    from langchain_core.output_parsers import StrOutputParser

    chain = (
        ChatPromptTemplate.from_template("解释 {concept}")
        | ChatOpenAI(model="gpt-4o-mini")
        | StrOutputParser()
    )

    async def main():
        # ⭐ astream_events：获取链中每个步骤的详细事件
        async for event in chain.astream_events(
            {"concept": "微服务"}, version="v2"
        ):
            kind = event["event"]

            if kind == "on_chat_model_stream":
                # LLM 输出的每个 token
                print(event["data"]["chunk"].content, end="")

            elif kind == "on_chain_start":
                print(f"\\n链开始: {event['name']}")

            elif kind == "on_tool_start":
                print(f"工具调用: {event['name']}")

    asyncio.run(main())

    # ⭐ 事件类型：
    # on_chain_start / on_chain_end
    # on_chat_model_start / on_chat_model_stream / on_chat_model_end
    # on_tool_start / on_tool_end
    # on_retriever_start / on_retriever_end
    #
    # 适用场景：
    # - 前端实时显示处理进度
    # - 复杂链的步骤可视化
    # - 调试 Agent 的推理过程
    """
    print(info)


# ───────────────────────────────────────────────────────────────
# 6. 生产环境流式方案
# ───────────────────────────────────────────────────────────────
def demo_production_streaming():
    print("══════ 6. 生产环境流式 ══════")

    info = """
    ⭐ FastAPI + LangChain 流式 API：

    ```python
    from fastapi import FastAPI
    from fastapi.responses import StreamingResponse
    from langchain_openai import ChatOpenAI
    from langchain_core.prompts import ChatPromptTemplate
    from langchain_core.output_parsers import StrOutputParser

    app = FastAPI()

    chain = (
        ChatPromptTemplate.from_template("{question}")
        | ChatOpenAI(model="gpt-4o-mini")
        | StrOutputParser()
    )

    @app.post("/chat")
    async def chat(question: str):
        async def generate():
            async for chunk in chain.astream({"question": question}):
                yield f"data: {chunk}\\n\\n"   # SSE 格式
            yield "data: [DONE]\\n\\n"

        return StreamingResponse(
            generate(),
            media_type="text/event-stream"
        )
    ```

    前端用 EventSource 或 fetch + ReadableStream 消费。
    """
    print(info)


if __name__ == "__main__":
    demo_custom_callback()
    demo_token_counting()
    demo_basic_streaming()
    demo_streaming_callback()
    demo_astream_events()
    demo_production_streaming()
