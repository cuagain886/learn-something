"""
═══════════════════════════════════════════════════════════════════
 04_lcel_chains —— LCEL（LangChain Expression Language）深入
═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. Runnable 协议：LangChain 的"万物基类"
 2. | 管道符组合
 3. RunnablePassthrough / RunnableParallel
 4. RunnableLambda 自定义逻辑
 5. 条件分支（RunnableBranch）
 6. 链的调试与可视化

【LCEL 的设计理念】
  每个组件（Prompt、LLM、Parser、Retriever...）都是 Runnable。
  Runnable 就像乐高积木块——每个都有统一的接口（invoke/stream/batch），
  可以用 | 管道符自由拼接。拼接后的整体也是 Runnable，天然支持流式和异步。

【运行】python main.py
"""
from dotenv import load_dotenv
load_dotenv()


# ───────────────────────────────────────────────────────────────
# 1. Runnable 协议
# ───────────────────────────────────────────────────────────────
def demo_runnable():
    print("══════ 1. Runnable 协议 ══════")

    info = """
    Runnable 接口（langchain_core.runnables.Runnable）：

    核心方法：
      invoke(input)     → 同步，输入 → 输出
      stream(input)     → 流式，输入 → Iterator[chunk]
      batch(inputs)     → 批量，List[输入] → List[输出]

    异步版本：
      ainvoke / astream / abatch

    组合方法：
      .pipe(other)      → 等价于 self | other
      .bind(**kwargs)    → 绑定默认参数

    谁是 Runnable？
      ✓ ChatPromptTemplate
      ✓ ChatOpenAI / ChatAnthropic
      ✓ StrOutputParser / JsonOutputParser
      ✓ VectorStoreRetriever
      ✓ RunnableLambda（任意函数）
      ✓ 用 | 组合出的链
    """
    print(info)


# ───────────────────────────────────────────────────────────────
# 2. 管道符组合
# ───────────────────────────────────────────────────────────────
def demo_pipe():
    print("══════ 2. 管道符组合 ══════")

    from langchain_openai import ChatOpenAI
    from langchain_core.prompts import ChatPromptTemplate
    from langchain_core.output_parsers import StrOutputParser

    # 最基本的链：Prompt → LLM → Parser
    chain = (
        ChatPromptTemplate.from_template("用一个比喻解释 {concept}")
        | ChatOpenAI(model="gpt-4o-mini", temperature=0.7)
        | StrOutputParser()
    )

    # ⭐ 数据流：
    # {"concept": "递归"}
    #   → ChatPromptTemplate → ChatPromptValue([HumanMessage])
    #     → ChatOpenAI → AIMessage
    #       → StrOutputParser → str

    result = chain.invoke({"concept": "递归"})
    print(f"  结果: {result}")

    # batch：批量调用（自动并发）
    results = chain.batch([
        {"concept": "闭包"},
        {"concept": "多态"},
    ])
    for r in results:
        print(f"  批量: {r[:50]}...")


# ───────────────────────────────────────────────────────────────
# 3. RunnablePassthrough —— 透传 / 数据增强
# ───────────────────────────────────────────────────────────────
def demo_passthrough():
    print("\n══════ 3. RunnablePassthrough ══════")

    from langchain_core.runnables import RunnablePassthrough, RunnableParallel
    from langchain_core.prompts import ChatPromptTemplate
    from langchain_core.output_parsers import StrOutputParser
    from langchain_openai import ChatOpenAI

    # ⭐ RunnablePassthrough.assign() 在不改变原始输入的情况下，添加新字段

    # 场景：用户输入 question，需要同时传入 question 和 word_count
    def count_words(input_dict):
        return len(input_dict["question"])

    chain = (
        RunnablePassthrough.assign(
            char_count=lambda x: len(x["question"]),
            upper_q=lambda x: x["question"].upper(),
        )
        | ChatPromptTemplate.from_template(
            "问题（{char_count}字符）：{question}\n大写：{upper_q}\n请回答这个问题。"
        )
        | ChatOpenAI(model="gpt-4o-mini", temperature=0)
        | StrOutputParser()
    )

    result = chain.invoke({"question": "什么是LCEL？"})
    print(f"  结果: {result[:100]}")


# ───────────────────────────────────────────────────────────────
# 4. RunnableParallel —— 并行执行
# ───────────────────────────────────────────────────────────────
def demo_parallel():
    print("\n══════ 4. RunnableParallel ══════")

    from langchain_core.runnables import RunnableParallel
    from langchain_core.prompts import ChatPromptTemplate
    from langchain_core.output_parsers import StrOutputParser
    from langchain_openai import ChatOpenAI

    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)

    # ⭐ RunnableParallel：并行执行多个链，结果合并为 dict
    # 也可以用 dict 字面量简写
    analysis = RunnableParallel(
        pros=ChatPromptTemplate.from_template("{topic} 的3个优点") | llm | StrOutputParser(),
        cons=ChatPromptTemplate.from_template("{topic} 的3个缺点") | llm | StrOutputParser(),
    )

    result = analysis.invoke({"topic": "微服务架构"})
    print(f"  优点: {result['pros'][:80]}...")
    print(f"  缺点: {result['cons'][:80]}...")

    # ⭐ dict 简写（效果一样）
    # analysis = {
    #     "pros": prompt_pros | llm | parser,
    #     "cons": prompt_cons | llm | parser,
    # }


# ───────────────────────────────────────────────────────────────
# 5. RunnableLambda —— 自定义逻辑
# ───────────────────────────────────────────────────────────────
def demo_lambda():
    print("\n══════ 5. RunnableLambda ══════")

    from langchain_core.runnables import RunnableLambda
    from langchain_core.prompts import ChatPromptTemplate
    from langchain_core.output_parsers import StrOutputParser
    from langchain_openai import ChatOpenAI

    # 任何 Python 函数都可以用 RunnableLambda 包装成 Runnable
    def preprocess(input_dict: dict) -> dict:
        """预处理：清洗输入"""
        return {
            "question": input_dict["question"].strip().lower(),
            "language": input_dict.get("language", "中文"),
        }

    def postprocess(text: str) -> dict:
        """后处理：包装结果"""
        return {
            "answer": text,
            "length": len(text),
        }

    chain = (
        RunnableLambda(preprocess)
        | ChatPromptTemplate.from_template("用{language}回答：{question}")
        | ChatOpenAI(model="gpt-4o-mini", temperature=0)
        | StrOutputParser()
        | RunnableLambda(postprocess)
    )

    result = chain.invoke({"question": "  什么是 LCEL？  "})
    print(f"  答案: {result['answer'][:80]}")
    print(f"  长度: {result['length']}")


# ───────────────────────────────────────────────────────────────
# 6. RunnableBranch —— 条件分支
# ───────────────────────────────────────────────────────────────
def demo_branch():
    print("\n══════ 6. 条件分支 ══════")

    from langchain_core.runnables import RunnableBranch, RunnableLambda
    from langchain_core.prompts import ChatPromptTemplate
    from langchain_core.output_parsers import StrOutputParser
    from langchain_openai import ChatOpenAI

    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)
    parser = StrOutputParser()

    # ⭐ RunnableBranch：根据条件选择不同的处理链
    # 类似 if-elif-else

    code_chain = ChatPromptTemplate.from_template(
        "作为编程专家回答: {question}"
    ) | llm | parser

    math_chain = ChatPromptTemplate.from_template(
        "作为数学老师，用简单的语言回答: {question}"
    ) | llm | parser

    general_chain = ChatPromptTemplate.from_template(
        "回答以下问题: {question}"
    ) | llm | parser

    # 分类函数
    def classify(input_dict):
        q = input_dict["question"].lower()
        if any(kw in q for kw in ["代码", "编程", "python", "函数", "bug"]):
            return "code"
        elif any(kw in q for kw in ["数学", "计算", "方程", "几何"]):
            return "math"
        return "general"

    branch = RunnableBranch(
        (lambda x: classify(x) == "code", code_chain),
        (lambda x: classify(x) == "math", math_chain),
        general_chain,   # 默认分支
    )

    for q in ["Python 装饰器怎么写？", "二次方程怎么解？", "今天天气如何？"]:
        result = branch.invoke({"question": q})
        print(f"  [{classify({'question': q})}] {q}")
        print(f"    → {result[:60]}...")


# ───────────────────────────────────────────────────────────────
# 7. 链的组合模式总结
# ───────────────────────────────────────────────────────────────
def demo_patterns():
    print("\n══════ 7. LCEL 组合模式 ══════")

    patterns = """
    ┌──────────────────────────────────────────────────────────┐
    │                 LCEL 组合模式速查                         │
    ├──────────────────────────────────────────────────────────┤
    │                                                          │
    │  1. 顺序执行（Pipeline）                                  │
    │     a | b | c                                            │
    │     数据从左到右流过每个组件                               │
    │                                                          │
    │  2. 并行执行（Parallel）                                  │
    │     RunnableParallel(x=chain_a, y=chain_b)              │
    │     或 {"x": chain_a, "y": chain_b}                     │
    │     同时执行，结果合并为 dict                              │
    │                                                          │
    │  3. 数据增强（Passthrough）                               │
    │     RunnablePassthrough.assign(new_field=fn)             │
    │     保留原始数据，添加新字段                               │
    │                                                          │
    │  4. 条件分支（Branch）                                    │
    │     RunnableBranch((条件, 链), ..., 默认链)               │
    │     根据输入条件路由到不同链                               │
    │                                                          │
    │  5. 自定义逻辑（Lambda）                                  │
    │     RunnableLambda(fn)                                   │
    │     把任何函数变成 Runnable                               │
    │                                                          │
    │  6. 绑定参数（Bind）                                      │
    │     llm.bind(temperature=0, stop=["\n"])                 │
    │     预设固定参数                                          │
    │                                                          │
    └──────────────────────────────────────────────────────────┘
    """
    print(patterns)


if __name__ == "__main__":
    demo_runnable()
    demo_pipe()
    demo_passthrough()
    demo_parallel()
    demo_lambda()
    demo_branch()
    demo_patterns()
