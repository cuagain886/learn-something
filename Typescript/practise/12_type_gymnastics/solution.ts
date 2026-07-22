/**
 * ============================================================
 * 练习 12 · 参考答案
 * ============================================================
 * 要点回顾：
 *   - keyof T → 键的联合；T[K] → 键对应的值类型（索引访问）
 *   - 条件类型像 if-else；对「裸联合」参数会逐成员分发
 *   - 映射类型 [K in keyof T] 可加/去修饰符 ?、readonly，批量改造对象
 *   - infer 在条件类型左侧捕获类型变量（函数返回值、数组元素、Promise 值等）
 *   - 模板字面量类型 + 内置 Capitalize/ Uncapitalize 可拼字符串字面量
 */

type Equal<X, Y> = [X] extends [Y] ? ([Y] extends [X] ? true : false) : false;
type Expect<T extends true> = T;

type Keys = keyof { a: 1; b: 2 };
type _q1 = Expect<Equal<Keys, 'a' | 'b'>>;

type IsString<T> = T extends string ? true : false;
type _q2a = Expect<Equal<IsString<'hi'>, true>>;
type _q2b = Expect<Equal<IsString<42>, false>>;

type MyPartial<T> = { [K in keyof T]?: T[K] };
type _q3 = Expect<Equal<MyPartial<{ a: 1; b: 2 }>, { a?: 1; b?: 2 }>>;

type MyReturnType<F> = F extends (...args: any[]) => infer R ? R : never;
type _q4a = Expect<Equal<MyReturnType<() => number>, number>>;
type _q4b = Expect<Equal<MyReturnType<(x: string) => boolean>, boolean>>;

type OnEvent<T extends string> = `on${Capitalize<T>}`;
type _q5a = Expect<Equal<OnEvent<'click'>, 'onClick'>>;
type _q5b = Expect<Equal<OnEvent<'submit'>, 'onSubmit'>>;

type ToArray<T> = T extends unknown ? T[] : never;
type _q6 = Expect<Equal<ToArray<'a' | 'b'>, 'a'[] | 'b'[]>>;

// 类型题：用 `npm run check` 验证。本文件无运行时输出。

export {};
