// main.js —— Vite 项目入口文件
// Vite 自动处理 ESM 导入、HMR、资源优化等

import './style.css';

// ==========================================
// 1. 模块导入演示
// ==========================================
import { formatDate, createElement } from './utils.js';

// ==========================================
// 2. 静态资源导入（Vite 特有功能）
// ==========================================
// 导入 JSON 文件 → 自动解析为对象（不需要 fetch!）
import packageInfo from '../package.json';

// 导入 CSS（已在 style.css 中导入）

// ==========================================
// 3. 环境变量
// ==========================================
// Vite 通过 import.meta.env 暴露环境变量
// 只有 VITE_ 前缀的变量会出现在这里
console.log('环境变量:', import.meta.env);
console.log('当前模式:', import.meta.env.MODE);       // "development" 或 "production"
console.log('开发环境?', import.meta.env.DEV);       // boolean
console.log('生产环境?', import.meta.env.PROD);     // boolean

// ==========================================
// 4. 页面渲染
// ==========================================
const app = document.getElementById('app');

// 显示项目信息
const info = createElement('div', { class: 'info-box' });
info.innerHTML = `
    <h2>⚡ Vite 项目已启动</h2>
    <p>项目名: <strong>${packageInfo.name}</strong></p>
    <p>Vite 版本: <strong>${packageInfo.devDependencies?.vite || '见 package.json'}</strong></p>
    <p>当前时间: <strong>${formatDate(new Date())}</strong></p>
    <p>运行模式: <strong>${import.meta.env.MODE}</strong></p>
`;
app.appendChild(info);

// 显示 Vite 功能卡片
const cards = [
    { icon: '⚡', title: '极速 HMR', desc: '修改此文件 → 保存 → 页面自动更新（不刷新！）' },
    { icon: '📦', title: 'ESM 原生', desc: '开发时使用浏览器原生 ES Module，无需打包' },
    { icon: '🔧', title: '开箱即用', desc: 'TypeScript/JSX/CSS/Sass 无需配置即可使用' },
    { icon: '🏗️', title: '生产构建', desc: 'npm run build → 输出优化后的静态文件到 dist/' },
    { icon: '🌍', title: '环境变量', desc: '.env 文件管理不同环境的配置' },
    { icon: '📸', title: '资源处理', desc: '可导入 JSON/图片/CSS，构建时自动优化' },
];

const grid = createElement('div', { class: 'feature-grid' });
cards.forEach(card => {
    const cardEl = createElement('div', { class: 'feature-card' });
    cardEl.innerHTML = `
        <div class="feature-icon">${card.icon}</div>
        <h3>${card.title}</h3>
        <p>${card.desc}</p>
    `;
    grid.appendChild(cardEl);
});
app.appendChild(grid);

// 开发提示
if (import.meta.env.DEV) {
    console.log('🔧 开发模式：Vite HMR 已启用');
    console.log('  尝试修改 src/main.js → 保存 → 观察浏览器变化');
}

// ==========================================
// HMR 热更新演示（可选）
// ==========================================
// Vite 支持 HMR API，可以在模块更新时执行自定义逻辑
if (import.meta.hot) {
    import.meta.hot.accept(() => {
        console.log('🔄 HMR: main.js 模块已热更新');
    });
}
