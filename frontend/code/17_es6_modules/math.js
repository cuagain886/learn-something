// ═══════════════════════════════════════════════════════════════
// math.js —— ES6 模块示例：命名导出 + 默认导出
// ═══════════════════════════════════════════════════════════════

// 命名导出：可以导出多个
export const PI = 3.14159;
export const E = 2.71828;

export function add(a, b) {
    return a + b;
}

export function multiply(a, b) {
    return a * b;
}

// 默认导出：一个模块只能有一个
// 导入时可以随意命名：import anything from './math.js'
export default function sum(...numbers) {
    return numbers.reduce((total, n) => total + n, 0);
}
