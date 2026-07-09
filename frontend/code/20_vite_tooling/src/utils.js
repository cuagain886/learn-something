// utils.js —— 演示 ES Module 导出

/**
 * 格式化日期（中文格式）
 */
export function formatDate(date) {
    return date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
}

/**
 * 创建 DOM 元素（便捷函数）
 */
export function createElement(tag, attrs = {}) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (key === 'class') {
            el.className = value;
        } else {
            el.setAttribute(key, value);
        }
    }
    return el;
}
