"""
═══════════════════════════════════════════════════════════════════
 11_tools —— 工具（Tools）
═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. 什么是 Tool（LLM 可调用的函数）
 2. @tool 装饰器定义工具
 3. StructuredTool（Pydantic 参数校验）
 4. 内置工具（搜索、计算、Wikipedia...）
 5. 工具绑定（bind_tools）与 tool calling

【核心概念】
  Tool = 函数 + 名称 + 描述 + 参数 schema
  LLM 根据工具的描述决定何时调用、传什么参数。
  LLM 本身不执行工具——它只生成工具调用请求，由你的代码执行。

【运行】python main.py
"""
from dotenv import load_dotenv
load_dotenv()


# ───────────────────────────────────────────────────────────────
# 1. @tool 装饰器
# ───────────────────────────────────────────────────────────────
def demo_tool_decorator():
    print("══════ 1. @tool 装饰器 ══════")

    from langchain_core.tools import tool

    @tool
    def add(a: int, b: int) -> int:
        """两个数相加"""
        return a + b

    @tool
    def multiply(a: int, b: int) -> int:
        """两个数相乘"""
        return a * b

    @tool
    def get_word_length(word: str) -> int:
        """计算单词或中文文本的字符长度"""
        return len(word)

    # 查看工具信息
    print(f"  工具名: {add.name}")
    print(f"  描述: {add.description}")
    print(f"  参数: {add.args_schema.model_json_schema()}")

    # 直接调用
    result = add.invoke({"a": 3, "b": 5})
    print(f"  3 + 5 = {result}")


# ───────────────────────────────────────────────────────────────
# 2. StructuredTool（更精细的参数控制）
# ───────────────────────────────────────────────────────────────
def demo_structured_tool():
    print("\n══════ 2. StructuredTool ══════")

    from langchain_core.tools import StructuredTool
    from pydantic import BaseModel, Field

    class WeatherInput(BaseModel):
        city: str = Field(description="城市名称，如'北京'")
        unit: str = Field(default="celsius", description="温度单位：celsius 或 fahrenheit")

    def get_weather(city: str, unit: str = "celsius") -> str:
        """查询指定城市的天气"""
        # 模拟天气 API
        weather_data = {
            "北京": {"temp": 25, "condition": "晴"},
            "上海": {"temp": 28, "condition": "多云"},
            "广州": {"temp": 32, "condition": "雷阵雨"},
        }
        data = weather_data.get(city, {"temp": 20, "condition": "未知"})
        temp = data["temp"] if unit == "celsius" else data["temp"] * 9/5 + 32
        return f"{city}：{data['condition']}，{temp}°{'C' if unit == 'celsius' else 'F'}"

    weather_tool = StructuredTool.from_function(
        func=get_weather,
        name="weather",
        description="查询城市天气",
        args_schema=WeatherInput,
    )

    result = weather_tool.invoke({"city": "北京"})
    print(f"  {result}")


# ───────────────────────────────────────────────────────────────
# 3. bind_tools —— 让 LLM 知道有哪些工具
# ───────────────────────────────────────────────────────────────
def demo_bind_tools():
    print("\n══════ 3. bind_tools ══════")

    from langchain_openai import ChatOpenAI
    from langchain_core.tools import tool
    from langchain_core.messages import HumanMessage

    @tool
    def add(a: int, b: int) -> int:
        """两个数相加"""
        return a + b

    @tool
    def multiply(a: int, b: int) -> int:
        """两个数相乘"""
        return a * b

    # ⭐ bind_tools：告诉 LLM 有哪些工具可用
    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)
    llm_with_tools = llm.bind_tools([add, multiply])

    # LLM 会根据问题决定是否调用工具
    response = llm_with_tools.invoke("3乘以4等于多少？")

    print(f"  内容: {response.content}")
    print(f"  工具调用: {response.tool_calls}")

    # ⭐ LLM 不执行工具！它只生成 tool_calls 请求
    # tool_calls 包含：工具名、参数、调用 ID
    if response.tool_calls:
        tc = response.tool_calls[0]
        print(f"    工具名: {tc['name']}")
        print(f"    参数: {tc['args']}")
        print(f"    调用ID: {tc['id']}")

    # 不需要工具的问题
    response2 = llm_with_tools.invoke("今天心情怎么样？")
    print(f"\n  不需要工具时:")
    print(f"    内容: {response2.content[:50]}")
    print(f"    工具调用: {response2.tool_calls}")  # 空列表


# ───────────────────────────────────────────────────────────────
# 4. 完整的工具调用循环
# ───────────────────────────────────────────────────────────────
def demo_tool_call_loop():
    """手动实现工具调用循环（Agent 的底层逻辑）"""
    print("\n══════ 4. 工具调用循环 ══════")

    from langchain_openai import ChatOpenAI
    from langchain_core.tools import tool
    from langchain_core.messages import HumanMessage, ToolMessage

    @tool
    def add(a: int, b: int) -> int:
        """两个数相加"""
        return a + b

    @tool
    def multiply(a: int, b: int) -> int:
        """两个数相乘"""
        return a * b

    tools = [add, multiply]
    tool_map = {t.name: t for t in tools}

    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0).bind_tools(tools)

    # ⭐ 完整流程：
    # 1. 发送用户消息
    # 2. LLM 返回 tool_calls
    # 3. 执行工具，返回 ToolMessage
    # 4. LLM 根据工具结果生成最终回答

    messages = [HumanMessage(content="先算 3+5，再把结果乘以 2")]

    # 第一轮：LLM 决定调用工具
    response = llm.invoke(messages)
    messages.append(response)
    print(f"  LLM 请求调用 {len(response.tool_calls)} 个工具")

    # 执行工具
    for tc in response.tool_calls:
        tool_fn = tool_map[tc["name"]]
        result = tool_fn.invoke(tc["args"])
        print(f"    执行 {tc['name']}({tc['args']}) = {result}")

        # ⭐ ToolMessage：把工具结果返回给 LLM
        messages.append(ToolMessage(
            content=str(result),
            tool_call_id=tc["id"],   # 必须和 tool_call 的 ID 对应
        ))

    # 第二轮：LLM 根据工具结果回答（可能还需要调用工具）
    response2 = llm.invoke(messages)

    if response2.tool_calls:
        # 还需要继续调用工具
        messages.append(response2)
        for tc in response2.tool_calls:
            tool_fn = tool_map[tc["name"]]
            result = tool_fn.invoke(tc["args"])
            print(f"    执行 {tc['name']}({tc['args']}) = {result}")
            messages.append(ToolMessage(content=str(result), tool_call_id=tc["id"]))
        response3 = llm.invoke(messages)
        print(f"\n  最终回答: {response3.content}")
    else:
        print(f"\n  最终回答: {response2.content}")


# ───────────────────────────────────────────────────────────────
# 5. 内置工具生态
# ───────────────────────────────────────────────────────────────
def demo_builtin_tools():
    print("\n══════ 5. 内置工具 ══════")

    info = """
    ┌──────────────────────────────────────────────────────────┐
    │  工具                  用途              安装             │
    ├──────────────────────────────────────────────────────────┤
    │  TavilySearchResults   网络搜索          langchain-tavily │
    │  WikipediaQueryRun     Wikipedia 查询    wikipedia        │
    │  PythonREPL            执行 Python 代码   内置            │
    │  ShellTool             执行 shell 命令    内置            │
    │  RequestsGetTool       HTTP GET 请求      内置            │
    │  DuckDuckGoSearch      搜索引擎          duckduckgo-search│
    │  ArxivQueryRun         学术论文搜索       arxiv            │
    └──────────────────────────────────────────────────────────┘

    ⚠️ 安全提醒：
    - PythonREPL 和 ShellTool 允许执行任意代码，生产环境慎用
    - 始终对 LLM 生成的代码进行沙箱隔离
    """
    print(info)


if __name__ == "__main__":
    demo_tool_decorator()
    demo_structured_tool()
    demo_bind_tools()
    demo_tool_call_loop()
    demo_builtin_tools()
