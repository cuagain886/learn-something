/**
 * 这是 module augmentation，不是创建一个新的 ambient module。
 * 顶层 import 先让本文件成为模块，也确保目标模块进入程序。
 */
import './trace-context.js';

declare module './trace-context.js' {
  interface TraceContext {
    readonly tenantId?: string;
  }
}
