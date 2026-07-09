/**
 * ============================================================
 * 第 03 课：函数（Functions）
 * ============================================================
 * 本节学什么：
 *   1. 参数与返回值类型注解
 *   2. 箭头函数（JS 的简洁函数写法）
 *   3. 可选参数 ? / 默认参数 / 剩余参数 ...
 *   4. 函数类型（把「函数」本身当成一种类型）
 *   5. 函数重载（overload）
 *   6. this 类型
 *
 * 运行：  npx tsx src/03-functions.ts
 */

// ------------------------------------------------------------
// 1. 基本函数：给参数和返回值标注类型
// ------------------------------------------------------------
// function 声明式
function multiply(a: number, b: number): number {
  return a * b;
}

// 箭头函数（arrow function）：JS 的简洁函数写法，常用于回调。
//   (参数) => 表达式        // 自动 return 表达式
//   (参数) => { 语句块 }    // 需要自己写 return
const square = (n: number): number => n * n;

// ------------------------------------------------------------
// 2. 可选参数、默认参数、剩余参数
// ------------------------------------------------------------

// 可选参数：在参数名后加 ?，表示可以不传（此时它的值为 undefined）。
// 注意：可选参数必须排在必填参数后面。
function greet(name: string, title?: string): string {
  // title 的类型是 string | undefined
  return title ? `${title} ${name}` : `Hi ${name}`;
}

// 默认参数：不传时使用默认值（同时也就隐含「可选」）。
function createUser(name: string, role: string = 'user'): string {
  return `${name}(${role})`;
}

// 剩余参数（rest parameter）：用 ... 收集任意多个参数为一个数组。
function sum(...nums: number[]): number {
  return nums.reduce((total, n) => total + n, 0);
}

// ------------------------------------------------------------
// 3. 函数类型（Function Type）
// ------------------------------------------------------------
// 可以把「函数的形状」描述成一种类型：(参数列表) => 返回值类型
type BinaryOp = (a: number, b: number) => number;

// 然后用这个类型来约束变量：
const addOp: BinaryOp = (x, y) => x + y; // 参数 x、y 的类型由 BinaryOp 推断而来
const subOp: BinaryOp = (x, y) => x - y;

// 高阶函数：参数或返回值是函数。
function makeAdder(base: number): (n: number) => number {
  return (n) => base + n; // 返回一个新函数（闭包）
}
const add10 = makeAdder(10);

// ------------------------------------------------------------
// 4. 函数重载（Overloads）
// ------------------------------------------------------------
// 同一个函数，根据不同的参数类型，返回不同类型的结果。
// 写法：先写若干「重载签名」，再写一个「实现签名 + 函数体」。
// 实现签名对外不可见，调用者只能匹配上面的重载签名。

function parseInput(input: string): string[];
function parseInput(input: number): number[];
function parseInput(input: string | number): string[] | number[] {
  if (typeof input === 'string') {
    return input.split(''); // 字符串 → 字符数组
  }
  return [input]; // 数字 → 单元素数组
}

const chars = parseInput('abc'); // 类型被精确推断为 string[]
const nums = parseInput(42); // 类型被精确推断为 number[]

// ------------------------------------------------------------
// 5. this 类型
// ------------------------------------------------------------
// 普通函数里的 this 指向取决于「怎么调用」。TS 允许把 this 作为「假参数」标注，
// 放在参数列表第一位（它不占用真实参数位置）。
interface Counter {
  count: number;
  increment(this: Counter): void;
}

const counter: Counter = {
  count: 0,
  // 标注 this: Counter，TS 就会检查方法内对 this 的使用是否合法
  increment(this: Counter) {
    this.count++;
  },
};
counter.increment();
counter.increment();

console.log('=== 第 03 课：函数 ===');
console.log('multiply(3,4) =', multiply(3, 4));
console.log('square(5) =', square(5));
console.log('greet("Bob","Dr.") =', greet('Bob', 'Dr.'));
console.log('greet("Bob") =', greet('Bob'));
console.log('createUser("Amy") =', createUser('Amy'));
console.log('sum(1,2,3,4) =', sum(1, 2, 3, 4));
console.log('addOp/subOp =', addOp(8, 3), subOp(8, 3));
console.log('add10(5) =', add10(5));
console.log('parseInput =', chars, nums);
console.log('counter.count =', counter.count);

// 让本文件成为独立模块：每个 .ts 文件都有独立作用域，避免与其它课程文件的同名声明在全局冲突。
export {};
