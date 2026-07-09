"""
═══════════════════════════════════════════════════════════════════
 12_agents —— 智能体（Agent）
═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. Agent 是什么（vs Chain 的区别）
 2. 用 create_tool_calling_agent 创建 Agent
 3. AgentExecutor 执行循环
 4. Agent 的推理过程（观察 intermediate_steps）
 5. Agent 的常见问题

【Chain vs Agent】
  Chain：固定流程，A → B → C，你写代码决定每一步
  Agent：动态流程，LLM 决定下一步做什么、用什么工具、何时结束

  Agent = LLM + 工具 + 推理循环
          LLM 看到问题 → 决定调用工具 → 观察结果
          → 决定继续调用工具还是给出最终答案

【运行】python main.py
"""
from dotenv import load_dotenv
load_dotenv()


# ───────────────────────────────────────────────────────────────
# 1. 创建 Agent
# ───────────────────────────────────────────────────────────────
def demo_create_agent():
    print("══════ 1. 创建 Agent ══════")

    from langchain_openai import ChatOpenAI
    from langchain_core.tools import tool
    from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
    from langchain.agents import create_tool_calling_agent, AgentExecutor

    # 定义工具
    @tool
    def search_knowledge(query: str) -> str:
        """搜索知识库中的信息。当需要查找技术概念或定义时使用。"""
        knowledge = {
            "langchain": "LangChain 是一个 LLM 应用开发框架，支持 RAG、Agent 等模式。",
            "rag": "RAG（检索增强生成）通过检索外部文档来增强 LLM 回答。",
            "lcel": "LCEL 是 LangChain 的表达式语言，用 | 管道符组合组件。",
            "agent": "Agent 让 LLM 自主选择和使用工具来完成任务。",
        }
        for key, value in knowledge.items():
            if key in query.lower():
                return value
        return "未找到相关信息。"

    @tool
    def calculate(expression: str) -> str:
        """计算数学表达式。输入一个数学表达式字符串。"""
        try:
            result = eval(expression, {"__builtins__": {}})
            return str(result)
        except Exception as e:
            return f"计算错误: {e}"

    @tool
    def get_current_time() -> str:
        """获取当前日期和时间。"""
        from datetime import datetime
        return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    tools = [search_knowledge, calculate, get_current_time]

    # ⭐ Agent 的 Prompt 必须包含 agent_scratchpad
    prompt = ChatPromptTemplate.from_messages([
        ("system", "你是一个有帮助的助手。使用可用的工具来回答问题。用中文回答。"),
        ("human", "{input}"),
        MessagesPlaceholder(variable_name="agent_scratchpad"),
    ])

    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)

    # 创建 Agent
    agent = create_tool_calling_agent(llm, tools, prompt)

    # ⭐ AgentExecutor：执行 Agent 的推理循环
    agent_executor = AgentExecutor(
        agent=agent,
        tools=tools,
        verbose=True,         # 打印推理过程
        max_iterations=5,     # 最大迭代次数（防止死循环）
        handle_parsing_errors=True,  # 自动处理解析错误
    )

    # 测试
    result = agent_executor.invoke({"input": "LangChain 是什么？然后告诉我 123 * 456 等于多少"})
    print(f"\n  最终回答: {result['output'][:200]}")


# ───────────────────────────────────────────────────────────────
# 2. Agent 带对话历史
# ───────────────────────────────────────────────────────────────
def demo_agent_with_history():
    print("\n══════ 2. Agent 带对话历史 ══════")

    from langchain_openai import ChatOpenAI
    from langchain_core.tools import tool
    from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
    from langchain_core.messages import HumanMessage, AIMessage
    from langchain.agents import create_tool_calling_agent, AgentExecutor

    @tool
    def calculate(expression: str) -> str:
        """计算数学表达式"""
        try:
            return str(eval(expression, {"__builtins__": {}}))
        except Exception as e:
            return f"错误: {e}"

    # ⭐ 加入 chat_history 占位符
    prompt = ChatPromptTemplate.from_messages([
        ("system", "你是一个数学助手。用中文回答。"),
        MessagesPlaceholder(variable_name="chat_history"),
        ("human", "{input}"),
        MessagesPlaceholder(variable_name="agent_scratchpad"),
    ])

    agent = create_tool_calling_agent(
        ChatOpenAI(model="gpt-4o-mini", temperature=0),
        [calculate],
        prompt,
    )

    executor = AgentExecutor(agent=agent, tools=[calculate], verbose=False)

    # 多轮对话
    chat_history = []

    r1 = executor.invoke({"input": "帮我算 25 * 17", "chat_history": chat_history})
    print(f"  Q1: 帮我算 25 * 17")
    print(f"  A1: {r1['output']}")

    chat_history.extend([
        HumanMessage(content="帮我算 25 * 17"),
        AIMessage(content=r1['output']),
    ])

    r2 = executor.invoke({"input": "再加上 100 呢？", "chat_history": chat_history})
    print(f"  Q2: 再加上 100 呢？")
    print(f"  A2: {r2['output']}")


# ───────────────────────────────────────────────────────────────
# 3. Agent 的推理过程
# ───────────────────────────────────────────────────────────────
def demo_agent_reasoning():
    print("\n══════ 3. Agent 推理过程 ══════")

    info = """
    Agent 的推理循环（verbose=True 时可以看到）：

    ┌─────────────────────────────────────────────┐
    │  用户输入: "北京天气怎么样？明天要带伞吗？"    │
    │                                             │
    │  → LLM 思考: 需要查天气                      │
    │  → Action: search_weather(city="北京")       │
    │  → Observation: "北京：晴，25°C"              │
    │                                             │
    │  → LLM 思考: 已经有天气信息了                 │
    │  → Final Answer: "北京今天晴天25度，           │
    │    不需要带伞。"                              │
    └─────────────────────────────────────────────┘

    ⭐ intermediate_steps 记录了每一步：
    [
      (AgentAction(tool="search_weather", ...), "北京：晴，25°C"),
      ...
    ]

    可以用 return_intermediate_steps=True 获取：
    executor = AgentExecutor(..., return_intermediate_steps=True)
    result = executor.invoke({"input": "..."})
    steps = result["intermediate_steps"]
    """
    print(info)


# ───────────────────────────────────────────────────────────────
# 4. Agent 最佳实践
# ───────────────────────────────────────────────────────────────
def demo_best_practices():
    print("══════ 4. Agent 最佳实践 ══════")

    tips = """
    ⭐ 工具设计：
    1. 工具描述要清晰——LLM 靠描述决定何时用它
    2. 参数名要有意义——LLM 根据参数名填值
    3. 工具数量不宜太多——超过 10 个工具 LLM 容易选错
    4. 工具返回值要简洁——太长会浪费 token

    ⭐ 安全考虑：
    1. 永远不要让 Agent 执行未沙箱化的代码
    2. 设置 max_iterations 防止死循环
    3. 涉及副作用的工具（发邮件、写数据库）加人工确认
    4. 记录所有工具调用，便于审计

    ⭐ 调试技巧：
    1. verbose=True 查看推理过程
    2. 用 LangSmith 追踪每一步
    3. 先用简单问题测试，再逐步增加复杂度
    4. 如果 Agent 频繁出错，考虑用 Chain 替代

    ⭐ AgentExecutor vs LangGraph：
    - AgentExecutor：简单 Agent，线性推理循环
    - LangGraph：复杂 Agent，支持条件分支、循环、状态管理
    - 新项目推荐用 LangGraph（更灵活、更可控）
    """
    print(tips)


if __name__ == "__main__":
    demo_create_agent()
    demo_agent_with_history()
    demo_agent_reasoning()
    demo_best_practices()
