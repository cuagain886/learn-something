/**
 * ============================================================
 * 第 09 课：高级类型（Advanced Types / 类型编程）
 * ============================================================
 * 本节学什么（这一节是 TS「类型即编程」的精华）：
 *   1. keyof：取一个类型的所有键，组成字面量联合
 *   2. typeof：从「值」反推「类型」
 *   3. 索引访问类型 T[K]：取某个属性的类型
 *   4. 映射类型（Mapped Types）：遍历键，批量生成新类型
 *   5. 条件类型 T extends U ? X : Y
 *   6. infer：在条件类型里「提取」类型
 *   7. 模板字面量类型（Template Literal Types）
 *
 * 运行：  npx tsx src/09-advanced-types.ts
 *
 * 注意：本节几乎都是「类型层面」的运算，运行时没什么可打印的，
 *       重点是体会注释里推导出的类型。文件末尾用少量值验证一下。
 */

// ------------------------------------------------------------
// 1. keyof：拿到对象类型的「键集合」
// ------------------------------------------------------------
interface Person {
  name: string;
  age: number;
  email: string;
}
type PersonKeys = keyof Person; // 'name' | 'age' | 'email'
const k: PersonKeys = 'name'; // 只能是这三个之一

// ------------------------------------------------------------
// 2. typeof：从一个「值」得到它的「类型」
// ------------------------------------------------------------
// 注意区分：JS 的 typeof 返回字符串（运行时）；TS 的 typeof 用在类型位置（编译时）。
const defaultConfig = {
  host: 'localhost',
  port: 8080,
  secure: false,
};
type Config = typeof defaultConfig; // { host: string; port: number; secure: boolean }
const cfg: Config = { host: '0.0.0.0', port: 80, secure: true };

// ------------------------------------------------------------
// 3. 索引访问类型 T[K]：取出属性的类型
// ------------------------------------------------------------
type AgeType = Person['age']; // number
type NameOrAge = Person['name' | 'age']; // string | number
type ValueOfPerson = Person[keyof Person]; // string | number（所有值类型的联合）

// ------------------------------------------------------------
// 4. 映射类型（Mapped Types）：遍历键，生成新类型
// ------------------------------------------------------------
// 语法：{ [K in 键的联合]: 值类型 }，类似「for...in 但作用在类型上」。

// 把所有属性变为可选（这其实就是内置 Partial 的实现）。
type MyPartial<T> = {
  [K in keyof T]?: T[K];
};
type PartialPerson = MyPartial<Person>; // 每个属性都变成可选

// 把所有属性变为只读（内置 Readonly 的实现）。
type MyReadonly<T> = {
  readonly [K in keyof T]: T[K];
};

// 修饰符前加 - 可以「移除」可选/只读。-? 表示去掉可选。
type Concrete<T> = {
  [K in keyof T]-?: T[K];
};

// 还能用 as 子句「重映射」键名（配合模板字面量类型，见下面）。
type Getters<T> = {
  [K in keyof T as `get${Capitalize<string & K>}`]: () => T[K];
};
type PersonGetters = Getters<Person>;
// 结果：{ getName: () => string; getAge: () => number; getEmail: () => string }

// ------------------------------------------------------------
// 5. 条件类型（Conditional Types）：T extends U ? X : Y
// ------------------------------------------------------------
// 像「类型层面的三元表达式」。
type IsString<T> = T extends string ? 'yes' : 'no';
type A = IsString<string>; // 'yes'
type B = IsString<number>; // 'no'

// 配合泛型做「类型筛选」：去掉联合里的 null/undefined（内置 NonNullable）。
type MyNonNullable<T> = T extends null | undefined ? never : T;
type C = MyNonNullable<string | null | undefined>; // string

// ------------------------------------------------------------
// 6. infer：在条件类型中「提取」出某个类型
// ------------------------------------------------------------
// infer R 表示「让 TS 帮我推断这里的类型，并命名为 R」。

// 提取数组元素类型
type ElementType<T> = T extends (infer U)[] ? U : never;
type E1 = ElementType<number[]>; // number
type E2 = ElementType<string[]>; // string

// 提取函数返回值类型（这就是内置 ReturnType 的原理）
type MyReturnType<T> = T extends (...args: any[]) => infer R ? R : never;
type R1 = MyReturnType<() => number>; // number
type R2 = MyReturnType<(x: string) => boolean>; // boolean

// 提取 Promise 解析出的类型
type Unwrap<T> = T extends Promise<infer V> ? V : T;
type U1 = Unwrap<Promise<string>>; // string

// ------------------------------------------------------------
// 7. 模板字面量类型（Template Literal Types）
// ------------------------------------------------------------
// 在「类型层面」拼接字符串，可生成大量精确的字符串联合类型。
type Lang = 'zh' | 'en';
type Page = 'home' | 'about';
type Route = `/${Lang}/${Page}`;
// 结果：'/zh/home' | '/zh/about' | '/en/home' | '/en/about'
const route: Route = '/en/about';

// 配合内置的 Uppercase / Lowercase / Capitalize / Uncapitalize 做字符串变换。
type EventName<T extends string> = `on${Capitalize<T>}`;
type ClickEvent = EventName<'click'>; // 'onClick'

console.log('=== 第 09 课：高级类型 ===');
console.log('（本节重点在编译期的类型推导，见注释）');
console.log({ k, cfg, route });
// 用一个真实对象演示 Getters 形状（值层面手动实现一下）
const personGetters: PersonGetters = {
  getName: () => 'Alice',
  getAge: () => 30,
  getEmail: () => 'alice@example.com',
};
console.log('getName() =', personGetters.getName());

// 让本文件成为独立模块：每个 .ts 文件都有独立作用域，避免与其它课程文件的同名声明在全局冲突。
export {};
