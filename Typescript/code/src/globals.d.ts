// globals.d.ts —— 全局类型声明文件（第 14 课配套）
// ------------------------------------------------------------
// .d.ts 是「只有类型、没有实现」的声明文件。这个文件用来向「全局作用域」
// 添加类型，TS 会自动加载它（因为它被 tsconfig 的 include 覆盖）。
//
// declare global 用于在「模块文件」里扩充全局类型。
// 末尾的 `export {}` 是关键：它让本文件被当作「模块」，declare global 才生效。

declare global {
  // 声明一个全局变量 APP_VERSION，类型为 string。
  // 声明只是「告诉 TS 它存在且是什么类型」，真正的赋值要在运行时代码里完成
  // （见 14-declaration-files.ts）。
  // eslint-disable-next-line no-var
  var APP_VERSION: string;
}

export {};
