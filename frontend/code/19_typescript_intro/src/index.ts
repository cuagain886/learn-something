/*
═══════════════════════════════════════════════════════════════════
 19_typescript_intro —— TypeScript 入门
═══════════════════════════════════════════════════════════════════

【本节学什么】
  1. TypeScript 是什么？—— JavaScript + 类型系统
  2. 基础类型注解：基本类型、数组、对象、函数
  3. interface vs type —— TS 的灵魂
  4. 泛型（Generics）速览
  5. 工具类型：Partial / Pick / Omit / Record
  6. 从 JS 到 TS 的迁移策略

【Java 程序员的视角】
  TypeScript ≈ JavaScript + Java 的类型安全。
  这是你学前端最容易上手的一课——TS 的很多设计直接借鉴了 Java/C#。
  TS 的类型只在编译时存在，运行时仍然是纯 JS（和 Java 泛型的类型擦除类似）。

【运行】
  cd 19_typescript_intro
  npm install
  npm run dev
*/

// ═══════════════════════════════════════════════════════════════
// 1. 基础类型注解
// ═══════════════════════════════════════════════════════════════

// 基本类型 —— 和 Java 几乎一样
let isDone: boolean = false;
let count: number = 42;           // TS 的 number 统一了 int/float/double
let username: string = "Alice";
let notSure: unknown = 4;        // unknown = 类型安全的 any（类似 Java 的 Object）
let nothing: null = null;
let notDefined: undefined = undefined;

// 数组 —— 两种写法
let list1: number[] = [1, 2, 3];
let list2: Array<number> = [1, 2, 3];  // 泛型写法（Java 程序员更熟悉）

// 元组（Tuple）—— 固定长度 + 已知类型的数组
let tuple: [string, number] = ["hello", 42];

// 枚举 —— 和 Java 几乎一样
enum Color { Red, Green, Blue }
let c: Color = Color.Green;
console.log(`枚举 Color.Green = ${c} (数字枚举)`);  // 1

// 字面量类型 —— JS/TS 独有的强大特性
type Direction = "up" | "down" | "left" | "right";  // 只能是这四个值之一！
let dir: Direction = "up";
// dir = "diagonal";  // ❌ 编译错误！

// void / never —— 函数返回值
function warnUser(): void {
    console.log("警告信息");  // 没有返回值（void）
}
function error(msg: string): never {
    throw new Error(msg);  // 永远不会正常返回
}

console.log("═══ TypeScript 基础类型 ═══");
console.log(`count=${count}, username=${username}, dir=${dir}`);

// ═══════════════════════════════════════════════════════════════
// 2. interface vs type —— 定义对象结构
// ═══════════════════════════════════════════════════════════════

// interface：描述一个对象的"形状"（类似 Java 的 interface，但有字段）
interface User {
    readonly id: number;       // readonly = 只读（类似 Java 的 final）
    name: string;
    email: string;
    age?: number;              // ? = 可选属性
    createdAt: Date;
}

// type：比 interface 更灵活（支持联合类型、交叉类型等）
type Role = "admin" | "user" | "guest";

type AdminUser = User & {      // & = 交叉类型（合并多个类型）
    role: "admin";
    permissions: string[];
};

// 使用 interface
const user: User = {
    id: 1,
    name: "张三",
    email: "zhangsan@example.com",
    // age 是可选的，可以不写
    createdAt: new Date(),
};
console.log("\n── User 对象 ──");
console.log(JSON.stringify(user, null, 2));

// interface vs type 怎么选？
// - 优先用 interface（可扩展、可被类实现）
// - 需要联合类型、映射类型时用 type

// ═══════════════════════════════════════════════════════════════
// 3. 函数类型
// ═══════════════════════════════════════════════════════════════

// 完整类型注解：参数 + 返回值
function add(a: number, b: number): number {
    return a + b;
}

// 箭头函数的类型注解
const multiply = (a: number, b: number): number => a * b;

// 函数类型签名
type MathOp = (a: number, b: number) => number;
const divide: MathOp = (a, b) => a / b;

// 可选参数 + 默认值
function greet(name: string, greeting: string = "你好"): string {
    return `${greeting}，${name}！`;
}

console.log("\n── 函数 ──");
console.log(`add(3,4)=${add(3, 4)}, multiply(5,6)=${multiply(5, 6)}`);
console.log(greet("李四"));

// ═══════════════════════════════════════════════════════════════
// 4. 泛型（Generics）—— 和 Java 几乎一样！
// ═══════════════════════════════════════════════════════════════

// 泛型函数
function first<T>(arr: T[]): T | undefined {
    return arr[0];
}

// 泛型接口
interface ApiResponse<T> {
    code: number;
    message: string;
    data: T;
}

// 泛型约束：<T extends ...>
function getProperty<T, K extends keyof T>(obj: T, key: K): T[K] {
    return obj[key];
}

console.log("\n── 泛型 ──");
console.log(`first<number>([1,2,3]) = ${first([1, 2, 3])}`);

const userResponse: ApiResponse<User> = {
    code: 200,
    message: "OK",
    data: user,
};
console.log("ApiResponse<User>:", JSON.stringify(userResponse, null, 2));
console.log(`getProperty(user, 'name') = ${getProperty(user, 'name')}`);

// ═══════════════════════════════════════════════════════════════
// 5. 实用工具类型（Utility Types）—— TS 的"魔法"
// ═══════════════════════════════════════════════════════════════

// Partial<T> —— 所有属性变可选
type PartialUser = Partial<User>;

// Pick<T, K> —— 从 T 中选取 K 属性
type UserBrief = Pick<User, "id" | "name">;

// Omit<T, K> —— 从 T 中排除 K 属性
type UserWithoutId = Omit<User, "id">;

// Record<K, V> —— 创建一个键为 K、值为 V 的对象类型
type UserMap = Record<string, User>;  // { [key: string]: User }

// Readonly<T> —— 所有属性变只读
type ReadonlyUser = Readonly<User>;

console.log("\n── 工具类型演示 ──");
const partial: PartialUser = { name: "只有名字" };  // 合法！
const brief: UserBrief = { id: 1, name: "张三" };    // 只有 id 和 name
console.log("Partial<User>:", partial);
console.log("Pick<User, id|name>:", brief);

// ═══════════════════════════════════════════════════════════════
// 6. 类型守卫（Type Guards）—— 运行时类型判断
// ═══════════════════════════════════════════════════════════════

type Animal = Dog | Cat;
interface Dog { type: "dog"; bark(): string; }
interface Cat { type: "cat"; meow(): string; }

function handleAnimal(animal: Animal) {
    // 可辨识联合（Discriminated Union）—— TS 最优雅的模式之一
    switch (animal.type) {
        case "dog":
            return animal.bark();   // TS 知道这里是 Dog
        case "cat":
            return animal.meow();   // TS 知道这里是 Cat
    }
}

// ═══════════════════════════════════════════════════════════════
// 7. 从 JS 迁移到 TS 的策略
// ═══════════════════════════════════════════════════════════════
/*
  1. tsconfig.json 的 strict: false 开始（宽松模式）
  2. .js 重命名为 .ts，逐个文件加类型
  3. any 是逃生舱 —— 先用 any 让项目跑起来，再逐步收紧
  4. 第三方库：npm install @types/xxx（如 @types/lodash）
  5. 严格模式（strict: true）是终极目标
*/

console.log("\n✅ 19_typescript_intro 完成！");
console.log("TS 是 Java 程序员上手前端最有安全感的一站。");
