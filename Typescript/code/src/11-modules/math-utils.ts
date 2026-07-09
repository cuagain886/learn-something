/**
 * math-utils.ts —— 第 11 课的「被导入」模块之一
 * ------------------------------------------------------------
 * 演示「命名导出」（named export）：一个文件可以导出多个具名成员。
 */

// 方式一：在声明前直接加 export
export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

// 导出一个常量
export const PI = 3.14159;

// 也可以导出「类型」。用 export type 标明它只是类型（编译后会被擦除）。
export type Operation = 'add' | 'subtract';

// 方式二：先声明，最后统一导出
function multiply(a: number, b: number): number {
  return a * b;
}
export { multiply };
