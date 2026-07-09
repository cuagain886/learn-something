/**
 * ============================================================
 * 第 07 课：泛型（Generics）
 * ============================================================
 * 本节学什么：
 *   1. 为什么需要泛型
 *   2. 泛型函数
 *   3. 泛型接口 / 泛型类
 *   4. 泛型约束 extends
 *   5. 默认泛型参数
 *   6. 多个类型参数 + keyof 的经典组合
 *
 * 运行：  npx tsx src/07-generics.ts
 *
 * 一句话理解泛型：把「类型」当成「参数」传进去。
 *   就像函数参数让你复用逻辑，泛型让你在「保留具体类型信息」的前提下复用代码。
 */

// ------------------------------------------------------------
// 1. 为什么需要泛型？
// ------------------------------------------------------------
// 假设要写一个「原样返回参数」的函数。
// 用 any 会丢失类型：返回值变成 any，调用者拿不到具体类型。
function identityBad(value: any): any {
  return value;
}
const r1 = identityBad('hello'); // r1 是 any —— 丢了 string 信息 😞

// 用泛型 <T>：T 是一个「类型占位符」，调用时被实际类型填充。
function identity<T>(value: T): T {
  return value;
}
const r2 = identity('hello'); // T 推断为 string，r2 是 string ✅
const r3 = identity(123); // T 推断为 number，r3 是 number ✅
// 也可以显式指定：identity<boolean>(true)

// ------------------------------------------------------------
// 2. 泛型函数：写一个类型安全的数组工具
// ------------------------------------------------------------
// 取数组第一个元素，返回类型自动跟随元素类型。
function firstElement<T>(arr: T[]): T | undefined {
  return arr[0];
}
const firstNum = firstElement([10, 20, 30]); // number | undefined
const firstStr = firstElement(['a', 'b']); // string | undefined

// 两个类型参数：把数组每一项做映射。
function mapArray<T, U>(arr: T[], fn: (item: T) => U): U[] {
  return arr.map(fn);
}
const lengths = mapArray(['hi', 'hello'], (s) => s.length); // number[]

// ------------------------------------------------------------
// 3. 泛型接口 / 泛型类
// ------------------------------------------------------------

// 泛型接口：描述「装着某种类型 T 的容器」。
interface ApiResponse<T> {
  code: number;
  data: T;
  message: string;
}
const userResp: ApiResponse<{ name: string }> = {
  code: 0,
  data: { name: 'Alice' },
  message: 'ok',
};

// 泛型类：一个可以装任意类型的栈（Stack）。
class Stack<T> {
  private items: T[] = [];
  push(item: T): void {
    this.items.push(item);
  }
  pop(): T | undefined {
    return this.items.pop();
  }
  get size(): number {
    return this.items.length;
  }
}
const numberStack = new Stack<number>();
numberStack.push(1);
numberStack.push(2);

// ------------------------------------------------------------
// 4. 泛型约束（Constraints）：extends
// ------------------------------------------------------------
// 有时需要「限制 T 至少具备某些属性」，用 T extends 某类型 来约束。
// 下面要求 T 必须有 length 属性，才能安全访问 .length。
interface HasLength {
  length: number;
}
function logLength<T extends HasLength>(value: T): T {
  console.log('长度是', value.length);
  return value;
}
logLength('hello'); // ✅ 字符串有 length
logLength([1, 2, 3]); // ✅ 数组有 length
// logLength(123);    // ❌ number 没有 length

// ------------------------------------------------------------
// 5. 默认泛型参数
// ------------------------------------------------------------
// 给类型参数一个默认值，不传时使用默认。
interface Container<T = string> {
  value: T;
}
const c1: Container = { value: 'hi' }; // 用默认 string
const c2: Container<number> = { value: 42 }; // 显式指定 number

// ------------------------------------------------------------
// 6. keyof + 泛型：类型安全地取对象属性（非常常用的模式）
// ------------------------------------------------------------
// K extends keyof T：K 只能是 T 的「某个键名」。
// 返回值 T[K]：对应那个键的「值类型」。
function getProperty<T, K extends keyof T>(obj: T, key: K): T[K] {
  return obj[key];
}
const personObj = { name: 'Bob', age: 30 };
const personName = getProperty(personObj, 'name'); // 类型为 string
const personAge = getProperty(personObj, 'age'); // 类型为 number
// getProperty(personObj, 'email'); // ❌ 'email' 不是 personObj 的键

console.log('=== 第 07 课：泛型 ===');
console.log({ r1, r2, r3, firstNum, firstStr, lengths });
console.log({ userResp, stackSize: numberStack.size });
console.log({ c1, c2, personName, personAge });

// 让本文件成为独立模块：每个 .ts 文件都有独立作用域，避免与其它课程文件的同名声明在全局冲突。
export {};
