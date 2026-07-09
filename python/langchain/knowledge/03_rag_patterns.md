# 03 · RAG 架构模式 ⭐⭐

> RAG 是当前 LLM 应用最核心的模式。从 Naive RAG 到 Advanced RAG 再到 Modular RAG，理解演进路径和各种优化技术。

---

## 1. RAG 三代演进

### 第一代：Naive RAG

```
用户问题 → 嵌入 → 向量搜索 → Top-K 文档 → 拼接到 Prompt → LLM 回答
```

**问题**：
- 检索质量差（查询和文档的语义空间不一致）
- 噪声多（Top-K 包含很多无关内容）
- 信息丢失（长文档被切碎后丢失上下文）
- 无法处理复杂查询（需要推理的问题）

### 第二代：Advanced RAG

在 Naive RAG 的基础上，在三个阶段优化：

```
           ┌── Pre-Retrieval ──┐
           │ 查询改写            │
           │ 查询分解            │
           │ HyDE               │
           └────────────────────┘
                   ↓
           ┌── Retrieval ───────┐
           │ 混合检索            │
           │ 多路召回            │
           │ 元数据过滤          │
           └────────────────────┘
                   ↓
           ┌── Post-Retrieval ──┐
           │ 重排序              │
           │ 上下文压缩          │
           │ 结果融合            │
           └────────────────────┘
```

### 第三代：Modular RAG

把 RAG 的各个环节模块化，根据任务动态组合：

```
查询 → [路由] → [改写] → [检索A + 检索B] → [重排序] → [压缩] → [生成]
         ↑                                                        ↓
         └──────────── [自我反思/重试] ←──────────────────────────┘
```

---

## 2. Pre-Retrieval 优化

### 2.1 查询改写（Query Rewriting）

用户原始查询往往不适合直接用于向量检索。

```python
# MultiQueryRetriever：一个查询 → 多个角度的查询
# 原始："Python 性能问题"
# 改写为：
#   1. "Python 程序运行缓慢的原因"
#   2. "如何优化 Python 代码的执行速度"
#   3. "Python 性能瓶颈及解决方案"

from langchain.retrievers.multi_query import MultiQueryRetriever
retriever = MultiQueryRetriever.from_llm(
    retriever=vectorstore.as_retriever(),
    llm=ChatOpenAI(),
)
```

### 2.2 查询分解（Query Decomposition）

复杂问题拆解为多个子问题，分别检索后合并。

```
原始："LangChain 和 LlamaIndex 在 RAG 方面的区别是什么？"
拆解：
  1. "LangChain 的 RAG 功能有哪些？"
  2. "LlamaIndex 的 RAG 功能有哪些？"
  3. "两者的设计理念有何不同？"
```

### 2.3 HyDE（假设文档嵌入）

```
原始查询 → LLM 生成"假设答案" → 对假设答案做嵌入 → 用假设答案的向量检索

直觉：假设答案和真实文档在嵌入空间中比原始问题更接近
```

### 2.4 Step-back Prompting

```
原始："Python 3.12 的 GIL 改动影响了哪些性能场景？"
回退：先问一个更抽象的问题 "Python 的 GIL 是什么？"
用两个查询的检索结果共同回答
```

---

## 3. Retrieval 优化

### 3.1 混合检索（Hybrid Search）

```
向量检索（语义匹配）+ 关键词检索（精确匹配）= 更好的召回率

from langchain.retrievers import EnsembleRetriever
from langchain_community.retrievers import BM25Retriever

bm25 = BM25Retriever.from_documents(docs)
vector = vectorstore.as_retriever()

ensemble = EnsembleRetriever(
    retrievers=[bm25, vector],
    weights=[0.4, 0.6],   # BM25 权重 40%，向量 60%
)
```

### 3.2 Parent Document Retriever

```
问题：小块检索精准，但缺少上下文
解决：用小块检索，但返回小块所属的大块

文档 → 切成大块（parent）→ 每个大块切成小块（child）
检索 child → 返回对应的 parent

from langchain.retrievers import ParentDocumentRetriever
```

### 3.3 Self-Query（自查询检索）

```python
# LLM 自动从自然语言中提取过滤条件
# "找2023年发表的关于 RAG 的论文"
# → query="RAG", filter={"year": 2023, "type": "paper"}

from langchain.retrievers.self_query import SelfQueryRetriever
```

### 3.4 MMR（最大边际相关性）

```
标准检索：返回最相似的 K 个（可能很多重复内容）
MMR：在相似度和多样性之间权衡

retriever = vectorstore.as_retriever(
    search_type="mmr",
    search_kwargs={"k": 5, "fetch_k": 20, "lambda_mult": 0.7}
    # fetch_k=20 先取20个，从中选5个最多样的
    # lambda_mult：0=最多样，1=最相似
)
```

---

## 4. Post-Retrieval 优化

### 4.1 重排序（Re-ranking）

```
向量检索的 Top-20 → Cross-Encoder 重新打分 → 取 Top-5

Cross-Encoder vs Bi-Encoder：
- Bi-Encoder：分别编码 query 和 doc，用余弦相似度（快，用于初筛）
- Cross-Encoder：同时编码 query+doc，更精确（慢，用于重排序）

# 使用 Cohere Reranker
from langchain_cohere import CohereRerank
compressor = CohereRerank(top_n=5)
```

### 4.2 上下文压缩

```
检索到的文档可能很长，大部分内容和查询无关。
用 LLM 提取/压缩只和查询相关的部分。

from langchain.retrievers import ContextualCompressionRetriever
from langchain.retrievers.document_compressors import LLMChainExtractor
```

### 4.3 Lost in the Middle

⚠️ 研究表明 LLM 对中间位置的信息关注度最低。

```
最佳做法：
- 把最相关的文档放在开头和结尾
- 中间放次要信息
- 或者减少总文档数
```

---

## 5. 索引优化

### 5.1 分块策略

| 策略 | 适用场景 | chunk_size |
|------|---------|-----------|
| 固定大小 | 通用文本 | 500-1000 |
| 按段落 | 结构化文档 | 变化 |
| 按语义 | 长文章 | 变化 |
| 按代码结构 | 源码 | 按函数/类 |

### 5.2 嵌入模型选择

| 模型 | 维度 | 特点 |
|------|------|------|
| text-embedding-3-small | 1536 | 性价比高 |
| text-embedding-3-large | 3072 | 最高质量 |
| BGE-M3 | 1024 | 多语言、开源 |
| Cohere embed-v3 | 1024 | 支持搜索/分类不同模式 |

### 5.3 元数据设计

```python
Document(
    page_content="...",
    metadata={
        "source": "report_2024.pdf",    # 文件来源
        "page": 15,                      # 页码
        "section": "3.2 性能优化",        # 章节
        "date": "2024-01-15",            # 日期
        "author": "张三",                # 作者
        "doc_type": "technical_report",  # 文档类型
    }
)
# 好的元数据让你可以做过滤检索，大幅提高精度
```

---

## 6. RAG 评估指标

| 指标 | 衡量什么 | 计算方式 |
|------|---------|---------|
| **Context Relevance** | 检索的文档和问题是否相关 | LLM 判断 |
| **Groundedness** | 回答是否基于检索到的文档 | LLM 判断 |
| **Answer Relevance** | 回答是否切题 | LLM 判断 |
| **Faithfulness** | 回答是否忠实于文档（无幻觉） | LLM 判断 |
| **Recall@K** | Top-K 中包含正确答案的比例 | 需要标注数据 |
| **MRR** | 正确答案的平均排名倒数 | 需要标注数据 |

⭐ 常用评估框架：RAGAS、LangSmith Evaluation

---

## 面试常见问题

**Q1：Naive RAG 有什么问题？如何优化？**
A：主要问题：1) 检索不准（查询和文档语义空间不一致）→ 查询改写/HyDE；2) 噪声多 → 重排序/压缩；3) 上下文丢失 → Parent Document Retriever。

**Q2：混合检索（Hybrid Search）的原理和优势？**
A：组合向量检索（语义匹配）和关键词检索（BM25 精确匹配）。向量检索擅长理解语义（"汽车" ≈ "轿车"），BM25 擅长精确匹配（专有名词、代码符号）。两者互补提高召回率。

**Q3：如何评估 RAG 系统的质量？**
A：三个维度：1) 检索质量（Context Relevance、Recall@K）；2) 生成质量（Faithfulness、Answer Relevance）；3) 端到端（Groundedness）。用 RAGAS 或 LangSmith 做自动评估。

---

## 一句话总结

RAG 优化的三个阶段（Pre/During/Post Retrieval）各有多种技术，核心思路是让检索更准（混合检索、查询改写）、让上下文更精（重排序、压缩），最终让 LLM 回答更靠谱。
