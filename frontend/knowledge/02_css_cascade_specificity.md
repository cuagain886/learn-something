# 02 · CSS 层叠与优先级 ⭐⭐

> CSS = Cascading Style Sheets（层叠样式表）。"层叠"才是 CSS 的本质。理解层叠规则 = 理解 CSS 为什么这样工作。

---

## 1. 一个样式从"写了"到"生效"，要过五关

当一个元素的样式和你写的不一致时，按以下顺序排查：

```
① 选择器匹配？（选择器写错了？）
   ↓
② 层叠顺序？（后写的覆盖先写的？）
   ↓
③ 特指度？（谁的优先级更高？）
   ↓
④ 继承？（该属性会从父元素继承吗？）
   ↓
⑤ 初始值？（该属性的默认值是什么？）
```

---

## 2. 层叠（Cascade）—— 样式来源的优先级

当多条规则命中同一元素时，按照以下来源优先级排序（从低到高）：

| 优先级 | 来源 | 说明 |
|--------|------|------|
| 1（最低） | 用户代理样式（User Agent） | 浏览器默认样式（如 h1 的 font-size） |
| 2 | 用户样式 | 用户在浏览器设置中自定义的样式 |
| 3 | 作者样式（Author） | 你写在 CSS 文件中的样式 |
| 4 | 作者样式 + `!important` | 你写的 `!important` |
| 5 | 用户样式 + `!important` | 用户设置的 `!important` |
| 6（最高） | 用户代理 + `!important` | 浏览器 `!important`（如 `display: none !important`） |

**同来源下**：后写的覆盖先写的（同一个样式表中的顺序）。

---

## 3. 特指度（Specificity）—— 选择器的"权重"

### 3.1 计算规则

特指度用 `(a, b, c, d)` 四元组表示：

| 位置 | 对应选择器 | 示例 |
|------|-----------|------|
| a=1 | 内联样式 | `<div style="color:red">` |
| b | ID 选择器 | `#header` |
| c | class / 属性 / 伪类 | `.box`, `[type]`, `:hover` |
| d | 类型 / 伪元素 | `div`, `::before` |

### 3.2 实战计算

```css
*                          /* (0,0,0,0) */
div                        /* (0,0,0,1) */
div p                      /* (0,0,0,2) */
.box                       /* (0,0,1,0) */
div.box                    /* (0,0,1,1) */
#header .nav a             /* (0,1,1,1) */
style="color:red"          /* (1,0,0,0) — 内联 */
!important                 /* ∞ — 打破一切规则 */
```

**比较规则**：从左到右逐位比较，遇到不等的位即分胜负。

```
(0,1,0,0) > (0,0,9,9)     ← ID 选择器只有一个，但比 99 个 class 优先级都高
(0,0,1,5) > (0,0,1,3)     ← 前三位一样，第四位 5 > 3
```

### 3.3 陷阱与最佳实践

**陷阱 1：`!important` 的 `!important`**

```css
.text { color: red !important; }
.text { color: blue !important; }   /* ← 蓝色胜出！同特指度下后写覆盖先写 */
```

**陷阱 2：不要用 ID 选择器写样式**（`(0,1,0,0)` 太高，后续难以覆盖）

**最佳实践**：尽量用单一 class 选择器（`(0,0,1,0)`），保持特指度平坦：

```css
/* ✅ 好：特指度扁平，易于覆盖 */
.Button { }
.Button--primary { }
.is-active { }

/* ❌ 坏：特指度层层叠加，难以维护 */
#app .sidebar ul li a.active { }
```

---

## 4. 继承（Inheritance）

### 4.1 哪些属性会继承？

| 会继承（默认） | 不会继承（默认） |
|---------------|-----------------|
| color, font-family, font-size | width, height, margin, padding |
| text-align, line-height | border, background |
| visibility, cursor | display, position |
| list-style | box-sizing, overflow |

### 4.2 控制继承

```css
.child {
    color: inherit;        /* 显式继承父元素的值 */
    color: initial;        /* 使用 CSS 规范定义的初始值 */
    color: unset;          /* 可继承属性 = inherit；不可继承属性 = initial */
    color: revert;         /* 回退到用户代理样式 */
    all: unset;            /* 一次性重置所有属性 */
}
```

---

## 5. CSS 自定义属性（CSS Variables）—— 打破层叠的利器

```css
:root {
    --primary-color: #4a90d9;
    --spacing-unit: 8px;
}

.button {
    background: var(--primary-color);
    padding: var(--spacing-unit) calc(var(--spacing-unit) * 2);
}

/* 局部覆盖：自定义属性也遵循层叠和继承规则 */
.dark-theme {
    --primary-color: #bb86fc;
}
```

**与预处理器变量（Sass/Less）的本质区别**：CSS 自定义属性在**运行时**生效，可以动态修改、遵循层叠规则；预处理器变量在编译时就被替换为具体值。

---

## 6. `@layer` —— CSS 层叠新纪元（2022+）

```css
/* 定义层的优先级顺序（第一个最低，最后一个最高） */
@layer reset, base, components, utilities;

@layer reset {
    * { margin: 0; padding: 0; box-sizing: border-box; }
}

@layer components {
    .card { padding: 20px; }
}

/* utilities 层的优先级高于 components 层，
   所以 .p-0 一定能覆盖 .card 的 padding */
@layer utilities {
    .p-0 { padding: 0; }
}
```

`@layer` 解决了 CSS 架构中的根本问题：**不用 `!important` 也能让工具类覆盖组件样式**。

---

## 一句话总结

CSS 的"C"（层叠）是它名字的一部分。理解层叠 = 理解 **来源优先级 × 特指度 × 书写顺序 × 继承** 四重规则的叠加。当样式"不生效"时，按这四步排查，比盲目加 `!important` 高效得多。
