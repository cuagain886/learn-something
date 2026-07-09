// string-tools.d.ts —— 为同目录下的 string-tools.js 提供「类型声明」。
// ------------------------------------------------------------
// 规则：当 TS 遇到 import './string-tools' 时，会优先用同名的 .d.ts 作为它的类型，
//       而真正运行的是 string-tools.js。这就是「给无类型 JS 补类型」的标准做法
//       （社区里大量的 @types/xxx 包就是这么工作的）。
//
// 这里只描述「形状」，没有任何实现（.d.ts 文件编译后会被完全擦除）。

export declare function shout(text: string): string;
export declare function repeat(text: string, times: number): string;
export declare const LIB_NAME: string;
