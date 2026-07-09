# 04 · 关键渲染路径与性能优化 ⭐⭐⭐

> 关键渲染路径（Critical Rendering Path，CRP）是浏览器在首屏渲染过程中必须经过的步骤序列。优化 CRP = 让用户更快看到页面。

---

## 1. 什么是关键渲染路径？

```
DNS 解析 → TCP 连接 → HTTP 请求 → 服务器响应 →
HTML 解析 → DOM 构建 → CSSOM 构建 → 渲染树 → 布局 → 绘制
```

CRP 特指从**接收到 HTML** 到**首次绘制**之间的关键步骤。这个路径上的任何优化，都能直接提升用户感知的性能。

---

## 2. Core Web Vitals —— Google 的三项核心指标

| 指标 | 全称 | 衡量什么 | 良好阈值 |
|------|------|---------|---------|
| **LCP** | Largest Contentful Paint | 最大内容绘制（用户看到主要内容的时间） | ≤ 2.5s |
| **FID** | First Input Delay | 首次输入延迟（用户交互的响应速度） | ≤ 100ms |
| **CLS** | Cumulative Layout Shift | 累积布局偏移（视觉稳定性） | ≤ 0.1 |

### LCP 的常见优化

- 优化服务器响应时间（CDN、缓存、预渲染）
- 优化资源加载（压缩、懒加载、预加载）
- 优化 JavaScript 和 CSS（减少阻塞、代码分割）

### FID 的常见优化

- 拆分长任务（Long Task，>50ms）
- 优化 JS 执行时间（代码分割、Tree Shaking）
- 使用 Web Worker 把重计算移出主线程

### CLS 的常见优化

- **永远给图片/视频/广告位设置明确的 width 和 height**
- 不要在已有内容上方动态插入内容（除非用户交互触发）
- 使用 `transform` 做动画，不要用 `top/left`

---

## 3. 首屏优化的六字箴言

```
减少、延迟、内联
```

### 3.1 减少（Reduce）

**减少关键资源数量**：首屏渲染不需要的资源（非关键 CSS、非关键 JS）都不应该阻塞 CRP。

```html
<!-- 非关键 CSS：使用 media 属性延迟加载 -->
<link rel="stylesheet" href="print.css" media="print">
<!-- 浏览器仍会下载，但不会阻塞渲染 -->

<!-- 非关键 JS：使用 defer/async -->
<script src="app.js" defer></script>
```

**减少资源大小**：

```bash
# 压缩 HTML/CSS/JS（构建工具自动完成）
# Gzip/Brotli 压缩（服务器配置）
# 图片压缩 + 现代格式（WebP/AVIF）
# Tree Shaking：删除未使用的代码
```

### 3.2 延迟（Defer）

**懒加载图片**：

```html
<!-- loading="lazy" 是原生浏览器 API，无需 JS！ -->
<img src="below-fold.jpg" loading="lazy" alt="...">

<!-- 非首屏的 iframe 也支持 -->
<iframe src="video.html" loading="lazy"></iframe>
```

**懒加载组件**：

```javascript
// React 示例：组件级别的懒加载
const HeavyChart = React.lazy(() => import('./HeavyChart'));
// 只在渲染到 HeavyChart 时才会加载它的 JS bundle
```

**按需加载第三方脚本**：

```javascript
// 只在用户需要时加载聊天插件
button.addEventListener('click', async () => {
    await import('./chat-widget.js');
    ChatWidget.open();
});
```

### 3.3 内联（Inline）

**关键 CSS 内联**：首屏渲染所需的最小 CSS 集直接放在 `<style>` 标签中。

```html
<!DOCTYPE html>
<html>
<head>
    <!-- 关键 CSS：直接内联在 HTML 中 -->
    <style>
        /* 只包含首屏可见元素的样式 */
        header { background: #333; }
        .hero { font-size: 2em; }
    </style>
    <!-- 完整 CSS：异步加载 -->
    <link rel="preload" href="/full.css" as="style" onload="this.onload=null;this.rel='stylesheet'">
    <noscript><link rel="stylesheet" href="/full.css"></noscript>
</head>
```

**关键 JS 最小化**：首屏交互必需的最小 JS 内联。

---

## 4. 资源提示（Resource Hints）—— 告诉浏览器优先加载什么

```html
<!-- preload：当前页面马上需要的资源（最高优先级） -->
<link rel="preload" href="hero-image.webp" as="image">
<link rel="preload" href="main.js" as="script">

<!-- prefetch：未来页面可能需要的资源（低优先级，空闲时下载） -->
<link rel="prefetch" href="next-page.js">

<!-- preconnect：提前建立连接（DNS + TCP + TLS） -->
<link rel="preconnect" href="https://api.example.com">

<!-- dns-prefetch：只提前解析 DNS（比 preconnect 更轻量） -->
<link rel="dns-prefetch" href="https://cdn.example.com">
```

| 提示 | 做什么 | 何时用 | 优先级 |
|------|--------|-------|--------|
| `preload` | 立即下载 | 本页面的关键资源 | 高 |
| `prefetch` | 空闲时下载 | 下一页可能需要的资源 | 低 |
| `preconnect` | 提前建立连接 | 跨域 API / CDN | 中 |
| `dns-prefetch` | 提前 DNS 解析 | 第三方域名 | 低 |

**⚠️ preload 的误区**：`preload` 中的资源如果 3 秒内未被使用，Chrome 会在 Console 打印警告。不要把所有东西都 preload——那样等于没有 preload。

---

## 5. 代码分割（Code Splitting）

现代前端打包工具（Vite/Webpack）支持多种代码分割方式：

```javascript
// 方式 1：动态 import（最常用）
const module = await import('./heavy-module.js');

// 方式 2：入口分割（多页面应用）
// vite.config.js → build.rollupOptions.input → 多个入口

// 方式 3：提取公共依赖（vendor chunk）
// 框架库（React/Vue）、工具库（lodash）→ 单独打包，利用浏览器缓存
```

**分析打包产物**：用 `rollup-plugin-visualizer`（Vite）或 `webpack-bundle-analyzer` 可视分析每个模块的大小。

---

## 6. 缓存策略

```
index.html          → 不缓存（no-cache / max-age=0）
app.abc123.js       → 永久缓存（max-age=31536000，文件名含 hash）
logo.png            → 永久缓存（文件名含 hash）
api 响应             → 协商缓存（ETag / Last-Modified）
```

**缓存层级**：

| 缓存位置 | 控制方式 | 生存时间 | 适用资源 |
|----------|---------|---------|---------|
| Service Worker | JS API（Cache API） | 程序控制 | 离线可用的核心资源 |
| HTTP 缓存 | Cache-Control 头 | HTTP 控制 | 所有静态资源 |
| 内存缓存 | 浏览器自动 | 标签页存在期间 | 当前页面已请求过的资源 |
| 浏览器缓存 | 浏览器自动 | 依 HTTP 缓存头 | 跨页面的静态资源 |

---

## 7. 性能监控

### Performance API

```javascript
// 测量关键时间点
const timing = performance.getEntriesByType('navigation')[0];
console.log('DNS:', timing.domainLookupEnd - timing.domainLookupStart);
console.log('TCP:', timing.connectEnd - timing.connectStart);
console.log('首字节 TTFB:', timing.responseStart - timing.requestStart);
console.log('DOM 可交互:', timing.domInteractive - timing.fetchStart);
console.log('DOM 完成:', timing.domComplete - timing.fetchStart);
```

### LCP 测量

```javascript
new PerformanceObserver((list) => {
    const entries = list.getEntries();
    const lastEntry = entries[entries.length - 1];
    console.log('LCP:', lastEntry.renderTime || lastEntry.loadTime);
}).observe({ type: 'largest-contentful-paint', buffered: true });
```

### CLS 测量

```javascript
let cls = 0;
new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) cls += entry.value;
    }
    console.log('CLS:', cls);
}).observe({ type: 'layout-shift', buffered: true });
```

---

## 8. 一张检查清单

部署到生产环境前，确认这些事：

- [ ] HTML/CSS/JS 已压缩（minify）
- [ ] 开启了 Gzip/Brotli 压缩
- [ ] 图片用了 WebP/AVIF + srcset 响应式 + loading="lazy"
- [ ] 静态资源文件名包含哈希（实现永久缓存）
- [ ] 非关键 JS 用了 defer/async
- [ ] 代码分割：首页 JS < 200KB（压缩后）
- [ ] 关键 CSS 已内联
- [ ] Web 字体使用了 font-display: swap（避免文字不可见）
- [ ] 无渲染阻塞资源（检查 Lighthouse 报告）
- [ ] LCP < 2.5s, CLS < 0.1（检查 Core Web Vitals）

---

## 一句话总结

性能优化不是事后的"加个缓存"，而是从**减少关键资源数量 → 缩小关键资源体积 → 缩短关键路径长度**三个维度系统性地减少浏览器从"收到 HTML"到"画出首屏"的路径。
