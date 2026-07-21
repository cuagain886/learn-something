/**
 * 第 11 课的叶子模块：同时导出 JavaScript 值和 TypeScript 类型。
 *
 * `operations`、`add`、`PI` 会出现在 JavaScript 产物中；
 * `Operation` 只存在于 checker 的类型空间，emit 时完全消失。
 */

// operations：字符串名 → 二元运算函数 的常量映射表。
// `as const` 让每个属性键保持字面量类型（'add' | 'subtract' | 'multiply'），
// 而不是被拓宽成通用 string；`satisfies` 则在保留这种精度的同时，
// 校验整个对象的形状——所有值都必须是 (left, right) => number。
// 两者组合，让后面派生的 Operation 类型与运行时表完全一致。
export const operations = {
  add: (left: number, right: number) => left + right,
  subtract: (left: number, right: number) => left - right,
  multiply: (left: number, right: number) => left * right,
} as const satisfies Record<string, (left: number, right: number) => number>;

// Operation：派生类型，= operations 所有键的联合 ('add' | 'subtract' | 'multiply')。
// keyof typeof 让"允许的字符串集合"和实际表保持同步：新增/删除函数后类型自动更新。
// emit 后这条 type 声明整个消失，运行时不留任何痕迹（对比下面的 PI、add 这些值导出）。
export type Operation = keyof typeof operations;

// calculate：以 Operation 字符串作索引查表，再调用拿到的函数。
// operation 参数被联合类型限定，调用方传错名字（如 'divide'）在编译期就被拒绝。
export function calculate(
  operation: Operation,
  left: number,
  right: number,
): number {
  return operations[operation](left, right);
}

// 把表里的函数单独平铺导出，方便调用方按需 `import { add } from ...` 直接用名字。
export const add = operations.add;
export const subtract = operations.subtract;
export const multiply = operations.multiply;

// PI 是一个纯值导出，和上面的函数一样会真实出现在 JS 产物里（与上面的类型导出形成对比）。
export const PI = Math.PI;
