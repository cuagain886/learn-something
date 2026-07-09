"""
═══════════════════════════════════════════════════════════════════
 14_structured_output —— 结构化输出（深入）
═══════════════════════════════════════════════════════════════════

【本节学什么】
 1. with_structured_output 的高级用法
 2. 枚举、嵌套对象、可选字段
 3. 提取链（Extraction Chain）
 4. 分类链（Classification）
 5. 多选择路由

【和 03_output_parsers 的区别】
  03 介绍了 OutputParser（提示词层面约束格式），
  本节深入 with_structured_output（API 层面的结构化输出），
  这是 LangChain v0.2+ 的推荐方式。

【运行】python main.py
"""
from dotenv import load_dotenv
load_dotenv()


# ───────────────────────────────────────────────────────────────
# 1. 基本结构化输出
# ───────────────────────────────────────────────────────────────
def demo_basic():
    print("══════ 1. 基本结构化输出 ══════")

    from langchain_openai import ChatOpenAI
    from pydantic import BaseModel, Field
    from typing import Optional
    from enum import Enum

    class Difficulty(str, Enum):
        EASY = "easy"
        MEDIUM = "medium"
        HARD = "hard"

    class CodeQuestion(BaseModel):
        """一道编程面试题"""
        title: str = Field(description="题目标题")
        difficulty: Difficulty = Field(description="难度等级")
        language: str = Field(description="推荐使用的编程语言")
        time_complexity: str = Field(description="最优解的时间复杂度")
        hint: Optional[str] = Field(default=None, description="提示（可选）")
        tags: list[str] = Field(description="标签列表，如 ['数组', '双指针']")

    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)
    structured_llm = llm.with_structured_output(CodeQuestion)

    result = structured_llm.invoke("生成一道关于二分查找的面试题")

    print(f"  标题: {result.title}")
    print(f"  难度: {result.difficulty.value}")
    print(f"  语言: {result.language}")
    print(f"  复杂度: {result.time_complexity}")
    print(f"  提示: {result.hint}")
    print(f"  标签: {result.tags}")


# ───────────────────────────────────────────────────────────────
# 2. 嵌套对象
# ───────────────────────────────────────────────────────────────
def demo_nested():
    print("\n══════ 2. 嵌套对象 ══════")

    from langchain_openai import ChatOpenAI
    from pydantic import BaseModel, Field

    class Ingredient(BaseModel):
        name: str = Field(description="食材名称")
        amount: str = Field(description="用量，如 '200g', '2个'")

    class Recipe(BaseModel):
        """一个菜谱"""
        name: str = Field(description="菜名")
        cuisine: str = Field(description="菜系，如 '川菜', '粤菜'")
        prep_time_minutes: int = Field(description="准备时间（分钟）")
        ingredients: list[Ingredient] = Field(description="所需食材列表")
        steps: list[str] = Field(description="烹饪步骤")
        tips: str = Field(description="烹饪小贴士")

    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)
    structured_llm = llm.with_structured_output(Recipe)

    result = structured_llm.invoke("给我一个麻婆豆腐的菜谱")

    print(f"  菜名: {result.name}")
    print(f"  菜系: {result.cuisine}")
    print(f"  时间: {result.prep_time_minutes} 分钟")
    print(f"  食材:")
    for ing in result.ingredients:
        print(f"    - {ing.name}: {ing.amount}")
    print(f"  步骤: {len(result.steps)} 步")
    print(f"  贴士: {result.tips}")


# ───────────────────────────────────────────────────────────────
# 3. 信息提取（Extraction）
# ───────────────────────────────────────────────────────────────
def demo_extraction():
    print("\n══════ 3. 信息提取 ══════")

    from langchain_openai import ChatOpenAI
    from langchain_core.prompts import ChatPromptTemplate
    from pydantic import BaseModel, Field
    from typing import Optional

    class Person(BaseModel):
        name: str = Field(description="人名")
        age: Optional[int] = Field(default=None, description="年龄")
        role: Optional[str] = Field(default=None, description="职位或角色")

    class ExtractedInfo(BaseModel):
        """从文本中提取的人物信息"""
        people: list[Person] = Field(description="文中提到的所有人")
        main_topic: str = Field(description="文本的主要话题")

    prompt = ChatPromptTemplate.from_messages([
        ("system", "从用户提供的文本中提取结构化信息。"),
        ("human", "{text}"),
    ])

    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)
    chain = prompt | llm.with_structured_output(ExtractedInfo)

    text = """
    张三是公司的技术总监，今年35岁，负责整个后端架构。
    他的团队成员李四（28岁，高级工程师）和王五（刚入职的实习生）
    一起在做一个 AI 客服项目。
    """

    result = chain.invoke({"text": text})
    print(f"  话题: {result.main_topic}")
    for p in result.people:
        print(f"  人物: {p.name}, 年龄={p.age}, 角色={p.role}")


# ───────────────────────────────────────────────────────────────
# 4. 分类（Classification）
# ───────────────────────────────────────────────────────────────
def demo_classification():
    print("\n══════ 4. 文本分类 ══════")

    from langchain_openai import ChatOpenAI
    from langchain_core.prompts import ChatPromptTemplate
    from pydantic import BaseModel, Field
    from enum import Enum

    class Sentiment(str, Enum):
        POSITIVE = "positive"
        NEGATIVE = "negative"
        NEUTRAL = "neutral"

    class Category(str, Enum):
        BUG = "bug"
        FEATURE = "feature_request"
        QUESTION = "question"
        PRAISE = "praise"

    class FeedbackClassification(BaseModel):
        """用户反馈的分类结果"""
        sentiment: Sentiment = Field(description="情感倾向")
        category: Category = Field(description="反馈类别")
        priority: int = Field(description="优先级 1-5，5 最高", ge=1, le=5)
        summary: str = Field(description="一句话摘要")

    prompt = ChatPromptTemplate.from_messages([
        ("system", "分析用户反馈并分类。"),
        ("human", "{feedback}"),
    ])

    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)
    chain = prompt | llm.with_structured_output(FeedbackClassification)

    feedbacks = [
        "登录页面点击按钮没有反应，已经试了好几次了！",
        "能不能加一个黑暗模式？我晚上用眼睛很难受",
        "这个产品太棒了，用起来非常流畅！",
    ]

    for fb in feedbacks:
        result = chain.invoke({"feedback": fb})
        print(f"  反馈: {fb[:30]}...")
        print(f"    情感={result.sentiment.value} "
              f"类别={result.category.value} "
              f"优先级={result.priority} "
              f"摘要={result.summary}")
        print()


# ───────────────────────────────────────────────────────────────
# 5. Union 类型路由
# ───────────────────────────────────────────────────────────────
def demo_routing():
    print("══════ 5. Union 类型路由 ══════")

    from langchain_openai import ChatOpenAI
    from langchain_core.prompts import ChatPromptTemplate
    from pydantic import BaseModel, Field
    from typing import Union

    class SearchAction(BaseModel):
        """搜索知识库"""
        query: str = Field(description="搜索查询词")

    class CalculateAction(BaseModel):
        """数学计算"""
        expression: str = Field(description="数学表达式")

    class DirectAnswer(BaseModel):
        """直接回答（不需要工具）"""
        answer: str = Field(description="回答内容")

    # ⭐ 用 Union 让 LLM 从多个类型中选择
    prompt = ChatPromptTemplate.from_messages([
        ("system", "根据用户问题，决定应该采取什么行动。"),
        ("human", "{question}"),
    ])

    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)

    # method="json_schema" 对 Union 类型支持更好
    chain = prompt | llm.with_structured_output(
        Union[SearchAction, CalculateAction, DirectAnswer]
    )

    questions = [
        "什么是 RAG？",
        "123 * 456 等于多少？",
        "你好",
    ]

    for q in questions:
        result = chain.invoke({"question": q})
        action_type = type(result).__name__
        print(f"  Q: {q}")
        print(f"    Action: {action_type} → {result}")
        print()


if __name__ == "__main__":
    demo_basic()
    demo_nested()
    demo_extraction()
    demo_classification()
    demo_routing()
