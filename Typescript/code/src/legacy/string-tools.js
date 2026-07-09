// string-tools.js —— 一个「没有类型」的普通 JavaScript 模块。
// 想象它是一个第三方老库，或者团队里一段没人写类型的旧代码。
// 第 14 课会用同目录下的 string-tools.d.ts 给它补上类型。

export function shout(text) {
  return text.toUpperCase() + '!';
}

export function repeat(text, times) {
  return Array.from({ length: times }, () => text).join(' ');
}

export const LIB_NAME = 'string-tools';
