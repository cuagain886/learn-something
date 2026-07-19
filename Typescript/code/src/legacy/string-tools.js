/**
 * 一个故意没有 JSDoc 类型的旧 ESM 库。
 * TypeScript 消费方看到的静态契约来自同名 string-tools.d.ts。
 */

export function shout(text) {
  return text.toUpperCase() + '!';
}

export function repeat(text, times) {
  return Array.from({ length: times }, () => text).join(' ');
}

/**
 * 这个导出故意违反配套 .d.ts，用来证明声明文件是“可被编译器信任的人工承诺”，
 * 并不会生成任何运行时校验。真实项目绝不能留下这种漂移。
 */
export function misdeclaredVersionCode() {
  return 'v-next';
}

export const LIB_NAME = 'string-tools';
