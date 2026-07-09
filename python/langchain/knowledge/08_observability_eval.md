# 08 · 可观测性与评估 ⭐

> LLM 应用不同于传统软件——输出是概率性的，不能只靠单元测试保证质量。你需要追踪、评估和持续监控。

---

## 1. 为什么 LLM 应用更需要可观测性

```
传统软件：确定性输入 → 确定性输出 → 单元测试覆盖
LLM 应用：相似输入 → 不同输出 → 需要统计评估

传统 Bug：代码错误 → 修代码
LLM Bug：提示词不好 / 检索不准 / 幻觉 → 需要追踪定位

传统成本：固定（CPU/内存）
LLM 成本：按 token 计费 → 需要监控
```

---

## 2. LangSmith 追踪

### 基本配置

```bash
# 环境变量
export LANGSMITH_TRACING=true
export LANGSMITH_API_KEY=ls-xxx
export LANGSMITH_PROJECT=my-project
```

设置后，所有 LangChain 调用自动上报到 LangSmith：

```
一次 chain.invoke() 的追踪数据：

├─ Chain: rag_chain (1.2s, $0.003)
│  ├─ Retriever: vector_search (0.3s)
│  │  └─ 检索到 3 个文档
│  ├─ ChatPromptTemplate: format (0.001s)
│  │  └─ 生成 1500 tokens 的 prompt
│  ├─ ChatOpenAI: gpt-4o-mini (0.8s, $0.003)
│  │  ├─ 输入: 1500 tokens
│  │  └─ 输出: 200 tokens
│  └─ StrOutputParser: parse (0.001s)
```

### 关键观测维度

| 维度 | 关注点 | 告警阈值 |
|------|--------|---------|
| **延迟** | P50/P95/P99 | P95 > 5s |
| **成本** | 每次调用/每天/每用户 | 单次 > $0.1 |
| **错误率** | API 错误、解析错误 | > 1% |
| **Token 使用** | 输入/输出 token 数 | 单次 > 10K |
| **缓存命中率** | 缓存有效性 | < 20% 考虑优化 |

### 自定义追踪

```python
from langsmith import traceable

@traceable(name="my_rag_pipeline", run_type="chain")
def rag_pipeline(question: str) -> str:
    docs = retrieve(question)
    answer = generate(question, docs)
    return answer

# 手动记录元数据
@traceable(metadata={"version": "v2", "model": "gpt-4o-mini"})
def my_function(input):
    ...
```

---

## 3. 评估框架

### LangSmith 评估

```python
from langsmith.evaluation import evaluate

# 1. 准备评估数据集
# 在 LangSmith UI 中创建，或用 API：
from langsmith import Client

client = Client()
dataset = client.create_dataset("rag_qa")

# 添加样例
client.create_examples(
    inputs=[
        {"question": "什么是 LCEL？"},
        {"question": "RAG 的流程是什么？"},
    ],
    outputs=[
        {"answer": "LCEL 是 LangChain 的表达式语言..."},
        {"answer": "RAG 的流程是加载文档、分割、嵌入..."},
    ],
    dataset_id=dataset.id,
)

# 2. 定义评估函数
def correctness_evaluator(run, example):
    """用 LLM 评估回答的正确性"""
    prediction = run.outputs["answer"]
    reference = example.outputs["answer"]
    
    # 用 LLM 做裁判
    score = llm.invoke(f"""
        参考答案：{reference}
        实际回答：{prediction}
        评分（0-1，1=完全正确）：
    """)
    
    return {"score": float(score), "key": "correctness"}

# 3. 运行评估
results = evaluate(
    rag_chain.invoke,
    data="rag_qa",
    evaluators=[correctness_evaluator],
)
```

### RAGAS 评估

```python
# pip install ragas
from ragas import evaluate
from ragas.metrics import (
    faithfulness,        # 忠实度：回答是否基于检索内容
    answer_relevancy,    # 回答相关性：回答是否切题
    context_precision,   # 上下文精度：检索内容是否相关
    context_recall,      # 上下文召回：是否检索到了必要信息
)

result = evaluate(
    dataset=eval_dataset,
    metrics=[faithfulness, answer_relevancy, context_precision, context_recall],
)

print(result)
# {
#   "faithfulness": 0.85,
#   "answer_relevancy": 0.92,
#   "context_precision": 0.78,
#   "context_recall": 0.88,
# }
```

---

## 4. 评估指标详解

### RAG 评估指标

```
              ┌──────────────────────────────────────┐
              │            RAG 评估维度                │
              ├──────────────────────────────────────┤
              │                                      │
              │  检索质量                              │
              │  ├─ Context Precision: 检索到的和查询相关吗？│
              │  ├─ Context Recall: 必要信息都检索到了吗？  │
              │  └─ Hit Rate: Top-K 中有正确文档吗？      │
              │                                      │
              │  生成质量                              │
              │  ├─ Faithfulness: 回答忠实于检索内容吗？   │
              │  ├─ Answer Relevancy: 回答切题吗？       │
              │  └─ Correctness: 回答正确吗？            │
              │                                      │
              │  端到端                                │
              │  └─ Groundedness: 回答有出处吗？          │
              │                                      │
              └──────────────────────────────────────┘
```

### Agent 评估指标

| 指标 | 衡量什么 |
|------|---------|
| 任务完成率 | Agent 是否成功完成了任务 |
| 工具使用正确率 | 是否选择了正确的工具 |
| 步骤效率 | 完成任务用了多少步（越少越好） |
| 成本 | 总 token 消耗 |
| 延迟 | 端到端时间 |

---

## 5. LLM-as-Judge（LLM 裁判）

用 LLM 来评估另一个 LLM 的输出——这是目前最常用的自动评估方式。

### 基本模式

```python
JUDGE_PROMPT = """
你是一个评估助手。请评估以下回答的质量。

问题：{question}
回答：{answer}
参考答案：{reference}

请从以下维度评分（1-5）：
1. 准确性：回答是否正确
2. 完整性：是否涵盖了要点
3. 简洁性：是否简洁明了

输出 JSON 格式：{{"accuracy": N, "completeness": N, "conciseness": N, "reason": "..."}}
"""
```

### 注意事项

```
⚠️ LLM-as-Judge 的已知问题：
1. 位置偏差：倾向于选择第一个选项
2. 长度偏差：倾向于给长回答更高分
3. 自我偏好：GPT-4 更倾向于给 GPT-4 的回答高分
4. 不稳定性：多次评分可能结果不同

解决方案：
- 多次评估取平均
- 随机化选项顺序
- 使用不同的 Judge 模型
- 结合人工评估做校准
```

---

## 6. 持续评估体系

```
开发阶段：
  ├─ 单元测试（确定性逻辑）
  ├─ 评估数据集（LLM 输出质量）
  └─ 手动测试（边界情况）

CI/CD 阶段：
  ├─ 回归测试（评估分数不下降）
  ├─ 成本测试（token 消耗不超标）
  └─ 延迟测试（P95 不超标）

线上阶段：
  ├─ 实时追踪（LangSmith）
  ├─ 用户反馈收集（👍👎）
  ├─ 异常检测（错误率飙升告警）
  └─ 定期抽样评估
```

### 反馈闭环

```
用户反馈 → 标注数据集 → 评估指标 → 优化 Prompt/检索 → 再评估
                ↑                                        │
                └────────────────────────────────────────┘
```

---

## 面试常见问题

**Q1：如何评估 RAG 系统的质量？**
A：从两个维度：1) 检索质量（Context Precision/Recall）——检索到的文档是否相关和完整；2) 生成质量（Faithfulness/Relevancy）——回答是否忠实于文档且切题。推荐用 RAGAS 或 LangSmith 做自动评估。

**Q2：什么是 LLM-as-Judge？有什么问题？**
A：用一个 LLM 来评估另一个 LLM 的输出。主要问题：位置偏差、长度偏差、自我偏好、评分不稳定。解决方案：多次评估、随机化、交叉验证、结合人工校准。

**Q3：LLM 应用的可观测性和传统应用有什么不同？**
A：传统应用主要看延迟和错误率。LLM 应用还需要：1) Token 使用量和成本监控；2) 输出质量评估（不是对就是错，而是有多好）；3) 每个中间步骤的追踪（检索了什么、prompt 是什么）。

---

## 一句话总结

LLM 应用的质量保证 = 追踪（LangSmith 看每一步在做什么）+ 评估（RAGAS/LLM-as-Judge 量化质量）+ 监控（成本/延迟/错误率持续告警），三者缺一不可。
