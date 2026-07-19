/**
 * 第 11 课的叶子模块：同时导出 JavaScript 值和 TypeScript 类型。
 *
 * `operations`、`add`、`PI` 会出现在 JavaScript 产物中；
 * `Operation` 只存在于 checker 的类型空间，emit 时完全消失。
 */

export const operations = {
  add: (left: number, right: number) => left + right,
  subtract: (left: number, right: number) => left - right,
  multiply: (left: number, right: number) => left * right,
} as const satisfies Record<string, (left: number, right: number) => number>;

export type Operation = keyof typeof operations;

export function calculate(
  operation: Operation,
  left: number,
  right: number,
): number {
  return operations[operation](left, right);
}

export const add = operations.add;
export const subtract = operations.subtract;
export const multiply = operations.multiply;
export const PI = Math.PI;
