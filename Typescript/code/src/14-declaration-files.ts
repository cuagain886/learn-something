/**
 * ============================================================
 * 第 14 课：声明文件（Declaration Files / .d.ts）
 * ============================================================
 * 本节学什么：
 *   1. .d.ts 是什么、有什么用
 *   2. 给「无类型的 JS 库」补类型（消费 ./legacy/string-tools.d.ts）
 *   3. 全局声明 declare global（消费 ./globals.d.ts 里声明的全局变量）
 *   4. declare module / 环境声明的常见用法（注释讲解）
 *
 * 运行：  npx tsx src/14-declaration-files.ts
 *
 * 一句话理解 .d.ts：
 *   它是「类型的说明书」，只描述形状、不含实现，编译后被擦除。
 *   作用是让 TS「认识」那些本身没带类型的东西（旧 JS、全局变量、特殊资源等）。
 */

// 1 & 2. 从一个「纯 JS 文件」导入。
// 运行时执行的是 legacy/string-tools.js；
// 而类型来自同目录的 legacy/string-tools.d.ts —— 于是我们获得了完整的类型提示。
import { shout, repeat, LIB_NAME } from './legacy/string-tools';

// 下面这些调用都有类型检查：参数类型错了会报错。
const loud = shout('hello'); // 推断为 string
const repeated = repeat('ab', 3); // 推断为 string
// shout(123);  // ❌ 若取消注释会报错：参数应为 string

// 3. 使用 globals.d.ts 里声明的全局变量 APP_VERSION。
// 声明只负责「类型」，这里负责「运行时赋值」。
globalThis.APP_VERSION = '1.0.0';

console.log('=== 第 14 课：声明文件 ===');
console.log('LIB_NAME =', LIB_NAME);
console.log('shout("hello") =', loud);
console.log('repeat("ab", 3) =', repeated);
console.log('全局 APP_VERSION =', globalThis.APP_VERSION);

/*
 * ------------------------------------------------------------
 * 附：其它常见的声明写法（仅讲解，不在本项目实际运行）
 * ------------------------------------------------------------
 *
 * // (a) 为一个完全没有 @types 的第三方包声明「环境模块」：
 * declare module 'some-untyped-pkg' {
 *   export function doSomething(x: number): string;
 *   const version: string;
 *   export default version;
 * }
 *
 * // (b) 让 TS 认识导入非代码资源（图片、样式等）：
 * declare module '*.png' {
 *   const url: string;
 *   export default url;
 * }
 *
 * // (c) 扩充已有库的类型（模块增强 Module Augmentation），
 * //     例如给 Express 的 Request 加自定义字段：
 * import 'express';
 * declare module 'express' {
 *   interface Request {
 *     userId?: string;
 *   }
 * }
 */
