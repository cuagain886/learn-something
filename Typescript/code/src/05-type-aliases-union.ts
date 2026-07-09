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
//   - 描述对象 / 类的结构（面向对象风格）
//   - 需要「声明合并」或被类 implements / extends
//
// 选 type 的场景：
//   - 联合类型、交叉类型、元组、函数类型
//   - 需要用到映射类型 / 条件类型等高级类型运算（见第 09 课）
//
// 经验法则：描述对象优先用 interface；其它一切类型运算用 type。两者常混用，没有绝对对错。

// 同样的对象，两种写法对照：
interface AnimalI {
  name: string;
}
type AnimalT = {
  name: string;
};

console.log('=== 第 05 课：类型别名、联合、交叉 ===');
console.log({ userId, origin, output, person });
printId(3.14159);
printId('abc');
const a1: AnimalI = { name: 'cat' };
const a2: AnimalT = { name: 'dog' };
console.log({ a1, a2 });

// 让本文件成为独立模块：每个 .ts 文件都有独立作用域，避免与其它课程文件的同名声明在全局冲突。
export {};
