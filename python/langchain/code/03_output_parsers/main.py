"""
═══════════════════════════════════════════════════════════════════
 03_output_parsers —— 输出解析器
═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. StrOutputParser（纯文本）
 2. JsonOutputParser（JSON 输出）
 3. PydanticOutputParser（类型安全的结构化输出）
 4. 自动注入格式指令
 5. 错误处理与重试

【核心问题】
  LLM 的原始输出是字符串。但实际应用中，你几乎总是需要结构化数据：
  JSON、列表、特定字段的对象...
  OutputParser 的职责就是把 LLM 的文本输出解析成你要的数据结构。

【运行】python main.py
"""
from dotenv import load_dotenv
load_dotenv()


# ───────────────────────────────────────────────────────────────
# 1. StrOutputParser
# ───────────────────────────────────────────────────────────────
def demo_str_parser():
    print("══════ 1. StrOutputParser ══════")

    from langchain_openai import ChatOpenAI
    from langchain_core.prompts import ChatPromptTemplate
    from langchain_core.output_parsers import StrOutputParser

    chain = (
        ChatPromptTemplate.from_template("用一句话解释 {concept}")
        | ChatOpenAI(model="gpt-4o-mini", temperature=0)
        | StrOutputParser()   # 提取 AIMessage.content → str
    )

    result = chain.invoke({"concept": "微服务"})
    print(f"  类型: {type(result)}")   # str
    print(f"  内容: {result}")


# ───────────────────────────────────────────────────────────────
# 2. JsonOutputParser
# ───────────────────────────────────────────────────────────────
def demo_json_parser():
    print("\n══════ 2. JsonOutputParser ══════")

    from langchain_openai import ChatOpenAI
    from langchain_core.prompts import ChatPromptTemplate
    from langchain_core.output_parsers import JsonOutputParser

    parser = JsonOutputParser()

    prompt = ChatPromptTemplate.from_messages([
        ("system", "你是一个技术分析师。{format_instructions}"),
        ("human", "分析 {language} 的优缺点"),
    ])

    # ⭐ partial：把 format_instructions 提前注入模板
    prompt = prompt.partial(
        format_instructions=parser.get_format_instructions()
    )

    chain = prompt | ChatOpenAI(model="gpt-4o-mini", temperature=0) | parser

    result = chain.invoke({"language": "Python"})
    print(f"  类型: {type(result)}")   # dict
    print(f"  内容: {result}")


# ───────────────────────────────────────────────────────────────
# 3. PydanticOutputParser（类型安全 ⭐）
# ───────────────────────────────────────────────────────────────
def demo_pydantic_parser():
    print("\n══════ 3. PydanticOutputParser ══════")

    from langchain_openai import ChatOpenAI
    from langchain_core.prompts import ChatPromptTemplate
    from langchain_core.output_parsers import PydanticOutputParser
    from pydantic import BaseModel, Field

    # 定义输出的数据结构
    class BookReview(BaseModel):
        title: str = Field(description="书名")
        author: str = Field(description="作者")
        rating: int = Field(description="评分（1-5）", ge=1, le=5)
        summary: str = Field(description="一句话评价")
        recommend: bool = Field(description="是否推荐")

    parser = PydanticOutputParser(pydantic_object=BookReview)

    prompt = ChatPromptTemplate.from_messages([
        ("system", "你是一个书评人。根据用户给的书名生成评论。\n{format_instructions}"),
        ("human", "评论《{book}》"),
    ]).partial(format_instructions=parser.get_format_instructions())

    chain = prompt | ChatOpenAI(model="gpt-4o-mini", temperature=0) | parser

    result = chain.invoke({"book": "流畅的Python"})
    print(f"  类型: {type(result)}")    # BookReview
    print(f"  书名: {result.title}")
    print(f"  评分: {result.rating}")
    print(f"  推荐: {result.recommend}")
    print(f"  评价: {result.summary}")


# ───────────────────────────────────────────────────────────────
# 4. with_structured_output（推荐方式 ⭐⭐）
# ───────────────────────────────────────────────────────────────
def demo_structured_output():
    """v0.2+ 推荐用 with_structured_output，比 PydanticOutputParser 更可靠"""
    print("\n══════ 4. with_structured_output ══════")

    from langchain_openai import ChatOpenAI
    from langchain_core.prompts import ChatPromptTemplate
    from pydantic import BaseModel, Field

    class City(BaseModel):
        name: str = Field(description="城市名")
        country: str = Field(description="所属国家")
        population: int = Field(description="大致人口数")
        famous_for: str = Field(description="最出名的一件事")

    # ⭐ with_structured_output：利用模型的 function calling 能力
    # 比 OutputParser 更可靠，因为是 API 层面保证格式
    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)
    structured_llm = llm.with_structured_output(City)

    prompt = ChatPromptTemplate.from_template("介绍城市：{city}")
    chain = prompt | structured_llm

    result = chain.invoke({"city": "杭州"})
    print(f"  类型: {type(result)}")   # City
    print(f"  城市: {result.name}")
    print(f"  国家: {result.country}")
    print(f"  人口: {result.population}")
    print(f"  闻名: {result.famous_for}")


# ───────────────────────────────────────────────────────────────
# 5. 列表输出与自定义解析
# ───────────────────────────────────────────────────────────────
def demo_custom_parser():
    print("\n══════ 5. 自定义解析 ══════")

    from langchain_openai import ChatOpenAI
    from langchain_core.prompts import ChatPromptTemplate
    from langchain_core.output_parsers import StrOutputParser
    from langchain_core.runnables import RunnableLambda

    # ⭐ 用 RunnableLambda 做自定义后处理
    def parse_numbered_list(text: str) -> list[str]:
        """解析编号列表格式的输出"""
        lines = text.strip().split("\n")
        items = []
        for line in lines:
            # 去掉 "1. " "2. " 等前缀
            cleaned = line.strip()
            for i in range(10):
                cleaned = cleaned.removeprefix(f"{i}. ").removeprefix(f"{i}）")
            items.append(cleaned.strip())
        return [item for item in items if item]

    chain = (
        ChatPromptTemplate.from_template("列出 {topic} 的5个要点，每行一个，用编号")
        | ChatOpenAI(model="gpt-4o-mini", temperature=0)
        | StrOutputParser()
        | RunnableLambda(parse_numbered_list)
    )

    result = chain.invoke({"topic": "学习 Python 的建议"})
    print(f"  类型: {type(result)}")   # list
    for i, item in enumerate(result, 1):
        print(f"  {i}. {item}")


# ───────────────────────────────────────────────────────────────
# 6. 总结对比
# ───────────────────────────────────────────────────────────────
def demo_summary():
    print("\n══════ 6. 解析器选择指南 ══════")
    summary = """
    ┌──────────────────────────────────────────────────────────┐
    │  场景                    推荐方案                         │
    ├──────────────────────────────────────────────────────────┤
    │  只需要纯文本            StrOutputParser                  │
    │  需要 JSON/dict          JsonOutputParser                │
    │  需要类型安全的对象       with_structured_output ⭐        │
    │  需要类型安全（老版本）   PydanticOutputParser            │
    │  自定义格式              RunnableLambda                  │
    │  流式 JSON               JsonOutputParser（支持 stream） │
    └──────────────────────────────────────────────────────────┘

    ⭐ 最佳实践：优先用 with_structured_output
       它底层走 function calling / tool calling API，
       格式由 API 保证，不依赖提示词指令。
    """
    print(summary)


if __name__ == "__main__":
    demo_str_parser()
    demo_json_parser()
    demo_pydantic_parser()
    demo_structured_output()
    demo_custom_parser()
    demo_summary()
