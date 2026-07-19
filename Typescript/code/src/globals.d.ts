/**
 * 全局扩充必须显式放在模块中；末尾的 export {} 防止本文件变成全局脚本，
 * 从而把所有顶层声明意外泄漏到整个程序。
 *
 * 注意：declare global 只修改 checker 所见的类型环境，不创建 JavaScript 属性。
 */

declare global {
  // `var` 才能描述 globalThis 上可读写的全局属性。
  // eslint-disable-next-line no-var
  var APP_VERSION: string;
}

export {};
