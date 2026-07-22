/**
 * ============================================================
 * 练习 01 · 参考答案
 * ============================================================
 * 对照 practice.ts 看：每个常量后都补上了【要求的】类型注解。
 * 关键点回顾：
 *   - 不写注解时，const 的字面量会推断成「最具体的字面量类型」
 *     （'Keyboard'、199.9、100n …），而不是 string / number / bigint。
 *   - 数组不写注解会推断成「可变元素数组」（number[]、(string|number)[]），
 *     想要只读或固定长度的元组，必须手写注解。
 *   - 对象属性默认可变；想要只读也要显式注解（第 7、8 题）。
 *   - @ts-expect-error：断言「下一行应当报错」，用来验证只读属性确实不可改。
 */

type Equal<X, Y> = [X] extends [Y] ? ([Y] extends [X] ? true : false) : false;
type Expect<T extends true> = T;

const productName: string = 'Keyboard';
type _q1 = Expect<Equal<typeof productName, string>>;

const price: number = 199.9;
type _q2 = Expect<Equal<typeof price, number>>;

const big: bigint = 100n;
type _q3 = Expect<Equal<typeof big, bigint>>;

const nums: readonly number[] = [1, 2, 3];
type _q4 = Expect<Equal<typeof nums, readonly number[]>>;

const coords: [number, number] = [120, 30];
type _q5 = Expect<Equal<typeof coords, [number, number]>>;

const entry: readonly [string, number] = ['age', 30];
type _q6 = Expect<Equal<typeof entry, readonly [string, number]>>;

const config: { readonly port: number } = { port: 3000 };
// @ts-expect-error  port 只读
config.port = 8080;

const server: { readonly host: string; readonly port: number } = { host: 'localhost', port: 3000 };
// @ts-expect-error  host 只读
server.host = '0.0.0.0';

console.log('✅ 练习 01 全部通过：8 个注解已补齐，类型断言全部成立。');

export {};
