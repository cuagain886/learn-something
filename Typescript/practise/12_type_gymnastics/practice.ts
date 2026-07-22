/**
 * ============================================================
 * 练习 12 · 类型体操入门（Type-Level Programming）
 * ============================================================
 * 学习目标：
 *   - keyof T：取出对象所有键的联合
 *   - 条件类型 `T extends U ? A : B`：类型层面的 if-else
 *   - 映射类型 `[K in keyof T] ...`：遍历键，批量改造对象类型
 *   - infer：在条件类型里「捕获」某个类型变量
 *   - 模板字面量类型：`` `on${Capitalize<E>}` `` 拼接字符串字面量
 *   - 分发（distributive）：条件类型对「裸联合」会逐个成员判定
 *
 * ⚠️ 本练习【全是类型题】，必须用 `npm run check` 或 IDE 验证！
 *    `npx tsx` 不做类型检查（它用 esbuild 直接擦除类型），不能用来判断对错。
 *
 * 题型：把每个 = unknown 换成正确的类型表达式，让所有 _qN 断言成立。
 */

type Equal<X, Y> = [X] extends [Y] ? ([Y] extends [X] ? true : false) : false;
type Expect<T extends true> = T;

// ------------------------------------------------------------
// 第 1 题：keyof。取出 { a: 1; b: 2 } 的所有键。
// ------------------------------------------------------------
type Keys = unknown; // TODO: keyof<{ a: 1; b: 2 }>
type _q1 = Expect<Equal<Keys, 'a' | 'b'>>;

// ------------------------------------------------------------
// 第 2 题：条件类型。IsString<T>：T 是 string 得 true，否则 false。
//   提示：T extends string ? true : false
// ------------------------------------------------------------
type IsString<T> = unknown; // TODO
type _q2a = Expect<Equal<IsString<'hi'>, true>>;
type _q2b = Expect<Equal<IsString<42>, false>>;

// ------------------------------------------------------------
// 第 3 题：映射类型。手写一个 MyPartial：所有字段变可选。
//   提示：{ [K in keyof T]?: T[K] }
// ------------------------------------------------------------
type MyPartial<T> = unknown; // TODO
type _q3 = Expect<Equal<MyPartial<{ a: 1; b: 2 }>, { a?: 1; b?: 2 }>>;

// ------------------------------------------------------------
// 第 4 题：infer。手写 MyReturnType：提取函数的返回类型。
//   提示：F extends (...args: any[]) => infer R ? R : never
//   （infer R 就是「捕获」那个返回类型）
// ------------------------------------------------------------
type MyReturnType<F> = unknown; // TODO
type _q4a = Expect<Equal<MyReturnType<() => number>, number>>;
type _q4b = Expect<Equal<MyReturnType<(x: string) => boolean>, boolean>>;

// ------------------------------------------------------------
// 第 5 题：模板字面量类型。把事件名转成处理器名：'click' → 'onClick'。
//   提示：`on${Capitalize<T>}`（Capitalize 是内置的，首字母大写）
// ------------------------------------------------------------
type OnEvent<T extends string> = unknown; // TODO
type _q5a = Expect<Equal<OnEvent<'click'>, 'onClick'>>;
type _q5b = Expect<Equal<OnEvent<'submit'>, 'onSubmit'>>;

// ------------------------------------------------------------
// 第 6 题：分发（distributive）。把联合的每个成员各自包成数组。
//   提示：T extends unknown ? T[] : never
//   ⚠️ 注意：直接写 T[] 会得到 ('a'|'b')[] —— 一个混合数组；
//   而用「裸 T 的条件类型」会分发成 'a'[] | 'b'[] —— 两个独立数组类型。
// ------------------------------------------------------------
type ToArray<T> = unknown; // TODO
type _q6 = Expect<Equal<ToArray<'a' | 'b'>, 'a'[] | 'b'[]>>;

// ============================================================
// 做完后：运行 `npm run check`，所有 _qN 行不报错即完成。
// 对照答案：见同目录 solution.ts
// ============================================================

export {};
