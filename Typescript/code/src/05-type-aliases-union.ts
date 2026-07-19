/**
 * ============================================================
 * 第 05 课：类型别名、联合类型与交叉类型
 * ============================================================
 * 本节学什么：
 *   1. type 类型别名
 *   2. 联合类型 |（「或」：是 A 或 B）
 *   3. 交叉类型 &（「与」：同时是 A 和 B）
 *   4. 字面量联合（最常用的「枚举式」类型）
 *   5. interface vs type 该怎么选
 *
 * 运行：  npx tsx src/05-type-aliases-union.ts
 */

import assert from 'node:assert/strict';

// ------------------------------------------------------------
// 1. type 类型别名（Type Alias）
// ------------------------------------------------------------
// type 给「任意类型」起一个名字。不只是对象，原始类型、联合、函数都能命名。
type ID = number | string; // 给联合类型起名
type Point = { x: number; y: number }; // 给对象类型起名
type Handler = (event: string) => void; // 给函数类型起名

const userId: ID = 'u_123';
const origin: Point = { x: 0, y: 0 };

// ------------------------------------------------------------
// 2. 联合类型（Union Types）：A | B
// ------------------------------------------------------------
// 表示「值可能是这几种类型之一」。
type Result = number | string;

let output: Result = 42;
output = 'forty-two'; // 两种都行

// 使用联合类型的值时，只能访问「所有成员都共有」的属性/方法，
// 否则要先「收窄类型」（见第 08 课）。
function printId(id: number | string) {
  // id.toFixed(2); // ❌ string 没有 toFixed，不能直接用
  if (typeof id === 'number') {
    console.log('number id:', id.toFixed(2)); // 收窄为 number 后才能用
  } else {
    console.log('string id:', id.toUpperCase()); // 收窄为 string
  }
}

// ------------------------------------------------------------
// 3. 交叉类型（Intersection Types）：A & B
// ------------------------------------------------------------
// 表示「同时具备多个类型的全部成员」，常用于「合并」多个对象类型。
type HasName = { name: string };
type HasAge = { age: number };
type Person = HasName & HasAge; // 必须同时有 name 和 age

const person: Person = { name: 'Tom', age: 25 };

// 交叉只发生在类型层，不会在运行时合并两个对象。
function merge<Left extends object, Right extends object>(left: Left, right: Right): Left & Right {
  return Object.assign({}, left, right);
}
const mergedPerson = merge({ name: 'Ada' }, { age: 36 });
assert.deepEqual(mergedPerson, { name: 'Ada', age: 36 });

// 不相容 primitive 的交叉没有任何可达值，会归约为 never。
type Impossible = string & number;
type ExpectNever<Value extends never> = Value;
type ImpossibleProof = ExpectNever<Impossible>;

// ------------------------------------------------------------
// 4. 字面量联合（Literal Union）—— 实战中最常用
// ------------------------------------------------------------
// 把多个「具体字面量」用 | 连起来，得到一个精确取值集合。
// 比 enum 更轻量，且能直接用字符串字面量赋值。
type Theme = 'light' | 'dark' | 'auto';
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

function setTheme(theme: Theme) {
  console.log('切换主题为:', theme);
}
setTheme('dark');
// setTheme('blue'); // ❌ 'blue' 不在允许集合里 —— 编译期就拦住了拼写错误

// ------------------------------------------------------------
// 5. interface vs type：怎么选？
// ------------------------------------------------------------
// 共同点：都能描述对象的形状。
//
// 选 interface 的场景：
//   - 稳定、可扩充的对象契约
//   - 需要声明合并或接口继承
//
// 选 type 的场景：
//   - 联合类型、交叉类型、元组、函数类型
//   - 需要用到映射类型 / 条件类型等高级类型运算（见第 09 课）
//
// class 也能 implements 一个静态可知的对象 type alias；并非 interface 专属。
// 经验法则不是“对象永远 interface”，而是先判断是否需要开放扩充/声明合并，
// 再判断是否需要联合、映射、条件等 type 运算。

// 同样的对象，两种写法对照：
interface AnimalI {
  name: string;
}
type AnimalT = {
  name: string;
};

class AnimalClass implements AnimalT {
  constructor(readonly name: string) {}
}

// ------------------------------------------------------------
// 6. 可辨识联合：让非法组合无法表示
// ------------------------------------------------------------

type ToolResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly code: 'INVALID_INPUT' | 'EXECUTION_FAILED' };

function renderToolResult(result: ToolResult): string {
  if (result.ok) return `value=${result.value}`;
  return `error=${result.code}`;
}

const toolResult: ToolResult = { ok: false, code: 'INVALID_INPUT' };
assert.equal(renderToolResult(toolResult), 'error=INVALID_INPUT');

// @ts-expect-error success 分支不能同时携带 error code
const illegalResult: ToolResult = { ok: true, value: 'done', code: 'EXECUTION_FAILED' };
void illegalResult;

console.log('=== 第 05 课：类型别名、联合、交叉 ===');
console.log({ userId, origin, output, person, mergedPerson, toolResult });
printId(3.14159);
printId('abc');
const a1: AnimalI = { name: 'cat' };
const a2: AnimalT = { name: 'dog' };
const a3 = new AnimalClass('fox');
console.log({ a1, a2, a3 });

// 让本文件成为独立模块：每个 .ts 文件都有独立作用域，避免与其它课程文件的同名声明在全局冲突。
export {};
