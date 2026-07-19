/**
 * ============================================================
 * 第 01 课：基础类型（Basic Types）
 * ============================================================
 * 本节学什么：
 *   1. TypeScript 与 JavaScript 的关系（静态类型 vs 动态类型）
 *   2. 原始类型：string / number / boolean / bigint / symbol
 *   3. 数组、元组（tuple）、枚举（enum）
 *   4. 特殊类型：any / unknown / void / null / undefined / never / object
 *   5. 字面量类型（literal type）
 *
 * 运行：  npx tsx src/01-basic-types.ts
 *
 * 给「会其他语言但不熟 JS」的你：
 *   - TS 用静态类型描述 JS。绝大多数 JS 语法可被 TS 解析，但合法 JS 在 strict
 *     检查下仍可能报类型错误；“可迁移”不等于“无需修改即可严格通过”。
 *   - 类型注解写在「变量名后面、冒号之后」：let x: number = 1
 *     这点和 Python 的类型标注类似，但 TS 的类型会在「编译时」真正做检查。
 *   - 编译期检查：类型错误在你写代码/编译时就报错，运行前就能发现 bug。
 */

import assert from 'node:assert/strict';

// ------------------------------------------------------------
// 1. 原始类型（Primitive Types）
// ------------------------------------------------------------

// 字符串。JS 里字符串可用单引号、双引号或反引号(模板字符串)。
const myName: string = 'Alice';
// 模板字符串：用反引号 ` `，里面 ${} 可嵌入表达式（类似很多语言的字符串插值）。
const greeting: string = `Hello, ${myName}!`;

// 数字。JS/TS 不区分 int 和 float，统一是 IEEE-754 double。
// 因此还包含 NaN、Infinity、-Infinity 和 -0；整数精确范围受 MAX_SAFE_INTEGER 限制。
const age: number = 30;
const price: number = 9.9;
const hex: number = 0xff; // 也支持十六进制 0x、八进制 0o、二进制 0b
const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;
assert.equal(unsafeInteger + 1, unsafeInteger, '超过安全整数后，相邻整数可能无法区分');
assert.equal(Number.isNaN(Number.NaN), true);
assert.equal(Object.is(-0, 0), false, '-0 === 0，但 Object.is 能区分');

// 布尔
const isStudent: boolean = false;

// bigint：表示任意大的整数，字面量以 n 结尾。需要 target >= ES2020。
const big: bigint = 9007199254740991n;

// symbol：独一无二的值，常用作对象的唯一属性键。
// 不写 : symbol 时，const 会保留 unique symbol 身份；显式写 symbol 反而会拓宽。
const uniqueKey = Symbol('id');
type UniqueKey = typeof uniqueKey; // unique symbol，可作为名义化属性键

// ------------------------------------------------------------
// 2. 数组与元组
// ------------------------------------------------------------

// 数组有两种等价写法：T[]  或  Array<T>
const scores: number[] = [90, 85, 77];
const words: Array<string> = ['ts', 'js'];

// 元组（tuple）：长度固定、每个位置类型可不同的数组。
// 适合表示「一组有固定结构的值」，比如坐标、键值对。
const point: [number, number] = [10, 20];
const pair: [string, number] = ['age', 30];
// 带标签的元组（仅是可读性提示，不影响类型）：
const rgb: [r: number, g: number, b: number] = [255, 128, 0];

// “固定长度”主要是静态视图。可变 tuple 仍继承 Array 的 mutation API；
// 对协议返回值优先 readonly tuple，才能从类型上删除 push/splice。
const coordinate: readonly [x: number, y: number] = [10, 20];
// coordinate.push(30); // @ts-expect-error readonly tuple 没有可用的 push

// ------------------------------------------------------------
// 3. 枚举（enum）
// ------------------------------------------------------------

// 数字枚举：默认从 0 开始自增。Direction.Up === 0
enum Direction {
  Up,    // 0
  Down,  // 1
  Left,  // 2
  Right, // 3
}
const move: Direction = Direction.Up;

// 字符串枚举：每个成员必须显式赋值，调试时可读性更好。
enum Status {
  Active = 'ACTIVE',
  Inactive = 'INACTIVE',
}
const status: Status = Status.Active;

// enum 会生成运行时对象；数字 enum 还包含反向映射。
assert.equal(Direction[Direction.Up], 'Up');

// Agent JSON 协议通常更适合“常量对象 + 字面量联合”：运行时可枚举，wire value 透明。
const finishReasons = {
  stop: 'stop',
  toolCalls: 'tool_calls',
} as const;
type FinishReason = (typeof finishReasons)[keyof typeof finishReasons];
const finishReason: FinishReason = finishReasons.toolCalls;

// ------------------------------------------------------------
// 4. 特殊类型
// ------------------------------------------------------------

// any：关闭类型检查的「逃生舱」。能赋任何值、做任何操作，但失去类型保护。
// ⚠️ 尽量少用。滥用 any 等于退回到没有类型的 JS。
let anything: any = 42;
anything = 'now a string';
anything = true; // 都不报错

// any 会污染表达式：返回值也变成 any，危险性不局限在当前变量。
const contaminated = anything.missing?.deep?.value;
// contaminated.notCheckedAtAll(); // 编译器仍不会阻止，运行时可能失败

// unknown：「类型安全版的 any」。可以接收任何值，但使用前必须先收窄类型。
let notSure: unknown = 'maybe a string';
// console.log(notSure.length); // ❌ 直接用会报错：对象类型为 unknown
if (typeof notSure === 'string') {
  // 在这个分支里，TS 已确认它是 string，才允许访问 .length
  console.log('unknown 收窄为 string 后长度：', notSure.length);
}

// void：表示「没有返回值」，最常用于函数返回类型。
function logMessage(msg: string): void {
  console.log(msg);
  // 没有 return，或 return; 都可以
}

// `() => void` 表示调用方忽略返回值，不要求实现真的返回 undefined。
const ignoredReturn: () => void = () => 42;
const ignored: void = ignoredReturn();
assert.equal(ignored, 42, '运行时返回值仍存在，只是静态观察类型为 void');

// null 与 undefined：在 strict 模式下它们是独立类型，
// 不能随意赋给别的类型（这能帮你避免「空值」类 bug）。
const nothing: null = null;
const notDefined: undefined = undefined;

// never：表示「永远不会出现的值」。常见于：
//   - 总是抛异常的函数
//   - 不可能走到的分支（穷尽检查，见第 08 课）
function fail(message: string): never {
  throw new Error(message);
}

// object：表示「非原始类型」（即不是 number/string/boolean/symbol/null/undefined）。
const obj: object = { a: 1 };

// object、{}、Object 的含义不同。
const nonNullish: {} = 'primitive is allowed by {}';
// const nonPrimitive: object = 'text'; // ❌ object 排除 primitive
assert.equal(typeof nonNullish, 'string');

// ------------------------------------------------------------
// 5. 字面量类型（Literal Types）
// ------------------------------------------------------------

// 类型不仅可以是「string」，还可以精确到「某个具体的字符串值」。
// 下面这个变量只能是 'left' 或 'right'，赋别的值会报错。
let align: 'left' | 'right' = 'left';
align = 'right';
// align = 'center'; // ❌ 报错：'center' 不在允许的字面量里

// 字面量类型 + 联合，是 TS 表达「枚举式取值」的常用手段（比 enum 更轻量）。
type DiceRoll = 1 | 2 | 3 | 4 | 5 | 6;
const roll: DiceRoll = 4;

// 负向类型契约：这些行必须报错，否则 npm run typecheck 会失败。
// @ts-expect-error 普通 string 不能赋给封闭字面量联合
const invalidRoll: DiceRoll = 7;
void invalidRoll;

// interface/type 只存在于类型空间，运行时不能拿来 instanceof。
type ToolInput = { query: string };
const rawToolInput: unknown = { query: 'typescript' };
// rawToolInput instanceof ToolInput; // ❌ ToolInput 不是运行时值

// ------------------------------------------------------------
// 输出观察结果
// ------------------------------------------------------------
console.log('=== 第 01 课：基础类型 ===');
console.log({ greeting, age, price, hex, isStudent, big, uniqueKey: uniqueKey.toString() });
console.log({ scores, words, point, pair, rgb, coordinate });
console.log({ move, status });
console.log({ anything, nothing, notDefined, obj });
console.log({ align, roll, finishReason, rawToolInput });
logMessage('void 函数被调用了');

// 让本文件成为独立模块：每个 .ts 文件都有独立作用域，避免与其它课程文件的同名声明在全局冲突。
export {};
