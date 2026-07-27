/**
 * ============================================================
 * 练习 01 · 基础类型注解（Basic Type Annotations）
 * ============================================================
 * 学习目标：
 *   - 学会「在变量名后写 : 类型」给常量补上类型注解
 *   - 体会一个关键事实：不写注解时，TS 推断的类型常常【和你想的不一样】
 *     （比如 const x = 'hi' 推断成字面量 'hi'；[1,2] 推断成 number[] 而非元组）
 *
 * 题型：每个常量后面都【没有】类型注解，括号里写明了【要求】的类型。
 *      你的任务：在变量名后补上注解。
 *
 *   例如：const productName = 'Keyboard';   // 要求: string
 *   你改成：const productName: string = 'Keyboard';
 *
 * 如何自检（类型题）：
 *   - 第 1~6 题用 `Expect<Equal<typeof x, 要求>>` 编译期断言；写对注解后该行不再报错。
 *   - 第 7~8 题用 `@ts-expect-error`：把属性注解成【只读】后，「给它赋值」这一行应当报错，
 *     被 @ts-expect-error 吃掉；如果你没注解成只读，属性可改、这一行不报错，
 *     @ts-expect-error 反而会因「没用上」而报错 —— 以此强制你写只读注解。
 *   ⚠️ 断言行和 @ts-expect-error 行都不要改。
 *   验证用 `npm run check` 或看 IDE（tsx 不检查类型）。
 */

// ===== 测试小工具（类型断言，照抄即可，不用深究）=====
type Equal<X, Y> = [X] extends [Y] ? ([Y] extends [X] ? true : false) : false;
type Expect<T extends true> = T;

// ------------------------------------------------------------
// 第 1 题：原始类型 string。不写注解时 'Keyboard' 是字面量类型 'Keyboard'。
// ------------------------------------------------------------
const productName: string = 'Keyboard'; // 要求: string
type _q1 = Expect<Equal<typeof productName, string>>;

// 第 2 题：number。不写注解时 199.9 是字面量 199.9。
const price: number = 199.9; // 要求: number
type _q2 = Expect<Equal<typeof price, number>>;

// 第 3 题：bigint（字面量以 n 结尾）。不写注解时是字面量 100n。
const big: bigint = 100n; // 要求: bigint
type _q3 = Expect<Equal<typeof big, bigint>>;

// ------------------------------------------------------------
// 第 4 题：只读数组。不写注解时 [1,2,3] 是【可变】的 number[]。
//   提示：readonly number[]  或  ReadonlyArray<number>
// ------------------------------------------------------------
const nums: readonly number[] = [1, 2, 3]; // 要求: readonly number[]
type _q4 = Expect<Equal<typeof nums, readonly number[]>>;

// 第 5 题：元组（tuple）。不写注解时 [120, 30] 是 number[]（长度不限）。
//   想要「正好两个 number」必须用元组注解：[number, number]
const coords: [number,number] = [120, 30]; // 要求: [number, number]
type _q5 = Expect<Equal<typeof coords, [number, number]>>;

// 第 6 题：只读混合元组。不写注解时 ['age', 30] 是 (string | number)[]。
//   想要「第一个 string、第二个 number、长度固定」用：readonly [string, number]
const entry: readonly[string, number] = ['age', 30]; // 要求: readonly [string, number]
type _q6 = Expect<Equal<typeof entry, readonly [string, number]>>;

// ------------------------------------------------------------
// 第 7 题：只读对象。不写注解时 port 是「可变」的 number。
//   把 config 注解成 { readonly port: number }，使下面「改 port」报错。
// ------------------------------------------------------------
const config: { readonly port: number } = { port: 3000 }; // 要求: { readonly port: number }
// @ts-expect-error  port 只读，不能改（注解写对后这行才会报错被吃掉）
config.port = 8080;

// 第 8 题：嵌套只读对象。要求 host 和 port 都只读。
const server: { readonly host: string; readonly port: number } = { host: 'localhost', port: 3000 }; // 要求: { readonly host: string; readonly port: number }
// @ts-expect-error  host 只读，不能改
server.host = '0.0.0.0';

// ============================================================
// 做完后：运行 `npm run check`，当本文件不再有错误即完成。
// 对照答案：见同目录 solution.ts
// ============================================================

export {};
