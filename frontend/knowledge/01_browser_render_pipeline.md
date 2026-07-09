# 01 · 浏览器渲染流水线 ⭐⭐⭐

> 理解浏览器如何把 HTML/CSS/JS 变成屏幕上的像素，是写出高性能前端代码的基础。

---

## 1. 渲染流水线概览

浏览器从接收到 HTML 到渲染出页面，经过以下阶段：

```
HTML ──→ DOM Tree ──┐
                     ├──→ Render Tree ──→ Layout ──→ Paint ──→ Composite
CSS  ──→ CSSOM Tree ─┘
```

### 1.1 HTML 解析 → DOM 树

浏览器逐字节解析 HTML，构建 DOM（Document Object Model）树。这个过程是**增量式**的——浏览器一边下载 HTML，一边就开始构建 DOM。

**注意**：`<script>` 标签（不带 `defer`/`async`）会**阻塞 DOM 解析**，因为脚本可能调用 `document.write()` 往文档中写入内容。

### 1.2 CSS 解析 → CSSOM 树

CSS 解析构建 CSSOM（CSS Object Model）树。**CSS 解析不阻塞 DOM 构建**，但会**阻塞渲染**——浏览器必须等 CSS 加载完成才能渲染，因为：

- 如果先渲染默认样式，等 CSS 加载完后再重绘，用户会看到"闪烁"（FOUC — Flash of Unstyled Content）
- 因此 CSS 被设计为"渲染阻塞资源"

### 1.3 DOM + CSSOM → Render Tree

渲染树 = DOM 树 + CSSOM 树 的"合并"。每个 Render Tree 节点对应一个"有视觉输出的盒子"。

**不进入 Render Tree 的元素**：
- `display: none` 的元素（它们占据的空间也被移除）
- `<head>` 及其子元素
- `<script>` 标签

**注意**：`visibility: hidden` 的元素**会**进入 Render Tree（占空间，只是不可见）。

### 1.4 Layout（布局 / 重排）

计算每个 Render Tree 节点的**精确位置和大小**。布局是一个递归过程，从根节点开始，自顶向下、自左向右。

### 1.5 Paint（绘制）

将布局后的元素绘制到屏幕上。浏览器把元素分解成多个"图层"（Layer），每个图层独立绘制。

### 1.6 Composite（合成）

将各图层合成为最终的屏幕图像。这是**唯一由 GPU 处理**的阶段，也是动画性能最优的阶段。

---

## 2. 重排（Reflow）vs 重绘（Repaint）vs 合成（Composite）

| 操作 | 触发阶段 | 性能开销 | 示例操作 |
|------|---------|---------|---------|
| 修改几何属性 | Layout → Paint → Composite | ❌ 最高 | 改 width/height/padding/margin/top/left |
| 修改外观属性 | Paint → Composite | ⚠️ 中等 | 改 color/background/box-shadow |
| 仅合成属性 | Composite only | ✅ 最低 | 改 transform/opacity |

**关键结论**：JavaScript → Style → Layout → Paint → Composite 这条流水线中，**越早的阶段变化，代价越大**。动画要避开 Layout 和 Paint，只触 Composite。

---

## 3. 关键渲染路径（Critical Rendering Path）优化

### 3.1 减少渲染阻塞

```html
<!-- ❌ <script> 阻塞 DOM 解析 -->
<script src="app.js"></script>

<!-- ✅ defer：异步下载，等 DOM 解析完再执行 -->
<script src="app.js" defer></script>

<!-- ✅ async：异步下载，下载完立即执行（不保证顺序） -->
<script src="analytics.js" async></script>
```

| 属性 | 下载 | 执行时机 | 执行顺序 | 适用场景 |
|------|------|---------|---------|---------|
| 无 | 阻塞解析 | 立即 | 按书写顺序 | 不要用 |
| defer | 并行 | DOM 解析完后 | 按书写顺序 | 应用主脚本 |
| async | 并行 | 下载完立即 | 谁先下载完谁先执行 | 独立脚本（统计、广告） |

### 3.2 CSS 优化

- **关键 CSS 内联**：首屏必需的最小 CSS 放在 `<style>` 标签中，其余异步加载
- **避免 `@import`**：`@import` 会导致串行下载（浏览器必须先下载父 CSS 才能发现 `@import`）
- **避免复杂选择器**：`.widget:nth-child(2n+1)` 比 `.widget-odd` 慢得多

### 3.3 避免强制同步布局（Forced Synchronous Layout）

```javascript
// ❌ 强制同步布局：读布局属性 → 修改样式 → 读布局属性
// 每一步都会触发同步重排！
element.classList.add('wide');
const width = element.offsetWidth;  // 读 → 触发 Layout
element.style.height = width + 'px'; // 写 → 再次触发 Layout
const height = element.offsetHeight; // 又读 → 又触发 Layout

// ✅ 好的写法：批量读 → 批量写
const width = element.offsetWidth;   // 读
const height = element.offsetHeight; // 读
// 现在一起写
element.classList.add('wide');
element.style.height = width + 'px';
```

---

## 4. 高性能动画：只动 transform 和 opacity

```css
/* ✅ 最佳：只触发 Composite */
.element {
    transform: translateX(100px);  /* 位移 */
    opacity: 0.5;                   /* 透明度 */
}

/* ⚠️ 一般：触发 Paint（可接受，但避免高频使用） */
.element {
    color: red;
    background-color: blue;
}

/* ❌ 最差：触发 Layout（永远不要在动画中用这些） */
.element {
    width: 200px;
    height: 200px;
    top: 50px;
    left: 100px;
}
```

### transform 的优势

`transform` 操作的是 GPU 层面的"变换矩阵"，不影响文档流：

- `translate()` — 位移
- `rotate()` — 旋转
- `scale()` — 缩放
- `skew()` — 倾斜

### 使用 will-change 提示浏览器

```css
.animated-box {
    will-change: transform;  /* 告诉浏览器"这个元素会动"，提前创建独立图层 */
}
```

**⚠️ 不要滥用**：每个独立图层都消耗 GPU 显存。只在确实需要动画的元素上使用，动画结束后移除此属性。

---

## 5. React/Vue 中的渲染性能

- **虚拟 DOM** 本质上是在 JS 层面避免不必要的 DOM 操作（减少重排/重绘次数）
- **React.memo / Vue computed** 避免不必要的重渲染
- **requestAnimationFrame** 是动画的最佳选择（与屏幕刷新率同步，60fps）

---

## 6. DevTools 中的性能分析

- **Performance 面板**：录制 → 看 Main 线程 → 找长任务（Long Task，>50ms）
- **Rendering 面板**（F12 → 更多工具 → Rendering）：
  - Paint Flashing：绿色闪烁 = 正在重绘
  - Layout Shift Regions：蓝色闪烁 = 布局偏移
  - Layer Borders：橙色边框 = 独立图层

---

## 一句话总结

浏览器的渲染流水线是 Layout → Paint → Composite。最大化性能的核心策略是：**读写分离（避免强制同步布局）、动画只动 transform/opacity、关键 CSS 内联、脚本异步加载**。
