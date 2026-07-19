/**
 * 手写的外部模块声明必须镜像 string-tools.js 的模块形状。
 *
 * 该文件只参与 checker，不会自动验证或包装 JS 实现，也不会由 tsc 自动复制到
 * outDir；课程构建脚本会把它作为发布资产显式复制。
 */

export declare function shout(text: string): string;
export declare function repeat(text: string, times: number): string;

/** 故意错误的契约：运行时实际返回 string，第 14 课会观测这次漂移。 */
export declare function misdeclaredVersionCode(): number;

export declare const LIB_NAME: 'string-tools';
