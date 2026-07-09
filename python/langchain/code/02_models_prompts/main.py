"""
═══════════════════════════════════════════════════════════════════

    02_models_prompts —— 模型与提示词模板

═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. ChatModel 的配置与切换（OpenAI / Anthropic / Ollama）
 2. ChatPromptTemplate 的各种用法
 3. FewShotPromptTemplate（少样本提示）
 4. MessagesPlaceholder（动态消息插入）
 5. 提示词工程最佳实践

【运行】python main.py

【核心理念】
  LangChain 的模型抽象让你可以"写一次，到处跑"：
  - 所有 ChatModel 都实现 BaseChatModel 接口
  - 统一的 invoke/stream/batch 方法
  - 切换模型只需改一行实例化代码，业务逻辑不变
"""
import os
from dotenv import load_dotenv
load_dotenv()


# ───────────────────────────────────────────────────────────────
# 1. ChatModel 配置
# ───────────────────────────────────────────────────────────────
def demo_models():
    print("══════ 1. ChatModel 配置 ══════")

    from langchain_openai import ChatOpenAI

    # ── 基本配置参数 ──
    llm = ChatOpenAI(
        model="deepseek-v4-pro",
        temperature=0,          # 0=确定性，1=最随机
        max_tokens=500,         # 最大输出 token 数
        timeout=30,             # 超时秒数
        max_retries=2,          # 重试次数
        # model_kwargs={"top_p": 0.9},  # 传给 API 的额外参数
    )

    # ── 切换到不同模型：只改实例化 ──
    # from langchain_anthropic import ChatAnthropic
    # llm = ChatAnthropic(model="claude-sonnet-4-20250514", temperature=0)

    # from langchain_ollama import ChatOllama
    # llm = ChatOllama(model="llama3", temperature=0)  # 本地模型

    # ── 模型绑定（bind）：预设参数 ──
    # 比如固定某些调用参数，后续链中不用重复指定
    strict_llm = llm.bind(
        temperature=0,
        max_tokens=100,
    )

    result = strict_llm.invoke("一句话介绍 Python")
    print(f"  绑定参数后: {result.content}")


# ───────────────────────────────────────────────────────────────
# 2. ChatPromptTemplate 基础
# ───────────────────────────────────────────────────────────────
def demo_prompt_templates():
    print("\n══════ 2. PromptTemplate ══════")

    from langchain_core.prompts import ChatPromptTemplate

    # ── 方式一：from_template（简单场景） ──
    simple = ChatPromptTemplate.from_template(
        "把以下内容翻译成{language}：\n{text}"
    )
    # 查看模板的变量
    print(f"  变量: {simple.input_variables}")  # ['language', 'text']

    # 格式化（不调用 LLM，只生成 prompt）
    messages = simple.invoke({"language": "英文", "text": "你好世界"})
    print(f"  格式化结果: {messages}")

    # ── 方式二：from_messages（精确控制角色） ──
    chat_prompt = ChatPromptTemplate.from_messages([
        ("system", "你是一个{role}。回答要简洁，不超过{max_words}个字。"),
        ("human", "{question}"),
    ])

    messages = chat_prompt.invoke({
        "role": "数据库专家",
        "max_words": "50",
        "question": "什么是索引？",
    })
    print(f"  多角色消息: {messages.messages}")

    # ── 方式三：用 Message 类更灵活 ──
    from langchain_core.prompts import (
        SystemMessagePromptTemplate,
        HumanMessagePromptTemplate,
    )

    system = SystemMessagePromptTemplate.from_template(
        "你是{company}的客服，语气要{tone}。"
    )
    human = HumanMessagePromptTemplate.from_template("{question}")

    prompt = ChatPromptTemplate.from_messages([system, human])
    print(f"  所有变量: {prompt.input_variables}")


# ───────────────────────────────────────────────────────────────
# 3. MessagesPlaceholder（动态消息）
# ───────────────────────────────────────────────────────────────
def demo_messages_placeholder():
    print("\n══════ 3. MessagesPlaceholder ══════")

    from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
    from langchain_core.messages import HumanMessage, AIMessage

    # ⭐ MessagesPlaceholder 允许在模板中插入动态消息列表
    # 最常见的用途：插入对话历史
    prompt = ChatPromptTemplate.from_messages([
        ("system", "你是一个有帮助的助手。"),
        MessagesPlaceholder(variable_name="chat_history"),
        ("human", "{question}"),
    ])

    # 模拟对话历史
    history = [
        HumanMessage(content="我叫小明"),
        AIMessage(content="你好小明！有什么可以帮你的？"),
    ]

    messages = prompt.invoke({
        "chat_history": history,
        "question": "我叫什么名字？",
    })

    for msg in messages.messages:
        role = type(msg).__name__.replace("Message", "")
        print(f"  [{role}] {msg.content[:50]}")


# ───────────────────────────────────────────────────────────────
# 4. FewShotPromptTemplate（少样本提示）
# ───────────────────────────────────────────────────────────────
def demo_few_shot():
    print("\n══════ 4. Few-Shot 少样本 ══════")

    from langchain_core.prompts import ChatPromptTemplate, FewShotChatMessagePromptTemplate

    # 定义示例
    examples = [
        {"input": "高兴", "output": "sad"},
        {"input": "快", "output": "slow"},
        {"input": "大", "output": "small"},
    ]

    # 单个示例的格式模板
    example_prompt = ChatPromptTemplate.from_messages([
        ("human", "{input}"),
        ("ai", "{output}"),
    ])

    # 组合成 Few-Shot 模板
    few_shot = FewShotChatMessagePromptTemplate(
        example_prompt=example_prompt,
        examples=examples,
    )

    # 最终的完整模板
    final_prompt = ChatPromptTemplate.from_messages([
        ("system", "你是一个英语反义词翻译器。用户给中文词，你回答英文反义词。"),
        few_shot,
        ("human", "{input}"),
    ])

    # 查看生成的消息
    messages = final_prompt.invoke({"input": "热"})
    for msg in messages.messages:
        role = type(msg).__name__.replace("Message", "")
        print(f"  [{role}] {msg.content}")

    # 实际调用
    from langchain_openai import ChatOpenAI
    from langchain_core.output_parsers import StrOutputParser

    chain = final_prompt | ChatOpenAI(model="gpt-4o-mini", temperature=0) | StrOutputParser()
    result = chain.invoke({"input": "热"})
    print(f"  结果: {result}")


# ───────────────────────────────────────────────────────────────
# 5. 提示词工程技巧
# ───────────────────────────────────────────────────────────────
def demo_prompt_tips():
    print("\n══════ 5. 提示词工程技巧 ══════")

    tips = """
    ⭐ 提示词最佳实践：

    1. 明确角色和约束
       ✓ "你是一个 Python 高级工程师，只用中文回答，不超过100字"
       ✗ "帮我写代码"

    2. 给出输出格式要求
       ✓ "用 JSON 格式回答，包含 name 和 reason 字段"
       ✗ "告诉我结果"

    3. 使用 Few-Shot 示例
       给 2-3 个输入输出示例，模型会模仿格式

    4. 拆解复杂任务（Chain of Thought）
       "请分步骤思考：1. 分析需求 2. 设计方案 3. 给出结论"

    5. 分离指令和数据
       用分隔符（```、---、<data>）隔开指令和用户数据，防止注入

    6. 温度选择
       - temperature=0：事实性回答、代码生成、分类
       - temperature=0.3-0.7：创意写作、头脑风暴
       - temperature=1：极度创意（诗歌、故事）

    7. 迭代优化
       先跑通，看输出，针对性调整提示词，不要一步到位
    """
    print(tips)


if __name__ == "__main__":
    demo_models()
    demo_prompt_templates()
    demo_messages_placeholder()
    demo_few_shot()
    demo_prompt_tips()
