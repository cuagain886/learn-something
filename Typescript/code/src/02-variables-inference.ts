/**
 * ============================================================
 * 第 02 课：变量声明与类型推断（Variables & Type Inference）
 * ============================================================
 * 本节学什么：
 *   1. let / const / var 的区别
 *   2. 类型推断：很多时候不用手写类型，TS 会自动推断
 *   3. as const：把值「冻结」成最窄的字面量类型
 *   4. 类型断言：as 与 <T> 两种写法
 *   5. 非空断言 !
 *
 * 运行：  npx tsx src/02-variables-inference.ts
 */

// ------------------------------------------------------------
// 1. let / const / var
// ------------------------------------------------------------
// JS/TS 推荐使用 let 和 const，几乎不再用 var。
//   - const：常量，声明后不能重新赋值（但对象内部属性仍可改）。
//   - let：变量，可重新赋值。
//   - var：旧语法，作用域规则怪异（函数作用域 + 变量提升），避免使用。

const PI = 3.14159; // 推断为 number
let counter = 0; // 推断为 number
counter = counter + 1; // ✅ let 可重新赋值
// PI = 3; // ❌ const 不可重新赋值

// const 对象：引用不可变，但属性可变
const config = { debug: true };
config.debug = false; // ✅ 改属性可以
// config = {};        // ❌ 改引用不行

// ------------------------------------------------------------
// 2. 类型推断（Type Inference）
// ------------------------------------------------------------
// 当你在声明时直接赋值，TS 会自动推断类型，无需手写注解。
// 推荐：能让 TS 推断的就别手写，代码更简洁。

let message = 'hello'; // 推断为 string，等价于 let message: string
// message = 123;      // ❌ 因为已被推断为 string

// 注意 const 与 let 推断结果的差异：
const litStr = 'hello'; // 推断为字面量类型 'hello'（因为 const 不会变）
let varStr = 'hello'; // 推断为 string（因为 let 可能被改成别的字符串）

// 函数返回值也会被推断：
function add(a: number, b: number) {
  return a + b; // 返回类型被推断为 number，无需写 : number
}

// 上下文推断：根据「使用位置」反推参数类型。
const numbers = [1, 2, 3];
numbers.forEach((n) => {
  // 这里的 n 自动被推断为 number，因为 numbers 是 number[]
  console.log(n * 2);
});

// ------------------------------------------------------------
// 3. as const：常量断言
// ------------------------------------------------------------
// as const 会把整个字面量「锁死」成最具体、只读的类型。

const point1 = { x: 1, y: 2 }; // 类型：{ x: number; y: number }（属性可改）
const point2 = { x: 1, y: 2 } as const; // 类型：{ readonly x: 1; readonly y: 2 }
// point2.x = 5; // ❌ as const 后属性变为只读

// 对数组用 as const，会得到只读元组，常用于定义常量列表。
const ROLES = ['admin', 'user', 'guest'] as const;
// ROLES 的类型是 readonly ['admin', 'user', 'guest']
// 由此可以提取出联合类型（第 09 课会用到这个技巧）：
type Role = (typeof ROLES)[number]; // 'admin' | 'user' | 'guest'
const myRole: Role = 'admin';

// ------------------------------------------------------------
// 4. 类型断言（Type Assertion）
// ------------------------------------------------------------
// 当「你比编译器更清楚某个值的类型」时，可以用断言告诉 TS。
// ⚠️ 断言只是「我向编译器保证」，不会做任何运行时转换或检查，用错会埋 bug。

const someValue: unknown = 'this is a string';

// 写法一：as 语法（推荐，在 .tsx 里也能用）
const strLength1 = (someValue as string).length;

// 写法二：尖括号语法（在 .tsx React 文件里会和 JSX 冲突，故较少用）
const strLength2 = (<string>someValue).length;

// 常见场景：DOM 取元素（这里仅演示类型，不会真的运行 DOM）
// const input = document.getElementById('app') as HTMLInputElement;

// ------------------------------------------------------------
// 5. 非空断言 !（Non-null Assertion）
// ------------------------------------------------------------
// 在值后面加 !，表示「我保证它不是 null / undefined」。
// 同样不做运行时检查，仅用于让编译器放行。

function getLength(text?: string) {
  // text 的类型是 string | undefined
  // 加 ! 断言它一定有值（若实际为 undefined，运行时会出错）
  return text!.length;
}

console.log('=== 第 02 课：变量与类型推断 ===');
console.log({ PI, counter, message, litStr, varStr });
console.log('add(2,3) =', add(2, 3));
console.log({ point2, myRole });
console.log({ strLength1, strLength2 });
console.log('getLength("abc") =', getLength('abc'));

// 让本文件成为独立模块：每个 .ts 文件都有独立作用域，避免与其它课程文件的同名声明在全局冲突。
export {};
