/**
 * ============================================================
 * 第 10 课：内置工具类型（Utility Types）
 * ============================================================
 * 本节学什么：TS 自带的一批「类型变换工具」，它们都是用第 09 课的
 *   映射类型 / 条件类型 / infer 实现的。熟练使用它们能极大减少重复类型代码。
 *
 *   - Partial<T>      所有属性变可选
 *   - Required<T>     所有属性变必填
 *   - Readonly<T>     所有属性变只读
 *   - Pick<T, K>      只挑选若干属性
 *   - Omit<T, K>      排除若干属性
 *   - Record<K, V>    构造「键-值」对象类型
 *   - Exclude<T, U>   从联合 T 中去掉 U
 *   - Extract<T, U>   从联合 T 中保留 U
 *   - NonNullable<T>  去掉 null / undefined
 *   - ReturnType<F>   取函数返回值类型
 *   - Parameters<F>   取函数参数类型（元组）
 *   - Awaited<T>      取 Promise 解析后的类型
 *
 * 运行：  npx tsx src/10-utility-types.ts
 */

interface User {
  id: number;
  name: string;
  email: string;
  age: number;
}

// ------------------------------------------------------------
// Partial：常用于「更新对象」时只传部分字段
// ------------------------------------------------------------
function updateUser(user: User, patch: Partial<User>): User {
  return { ...user, ...patch }; // 用补丁覆盖原对象（... 是 JS 的展开运算符）
}
type PartialUser = Partial<User>; // { id?: number; name?: string; ... }

// ------------------------------------------------------------
// Required：与 Partial 相反，把可选变必填
// ------------------------------------------------------------
interface Options {
  debug?: boolean;
  verbose?: boolean;
}
type StrictOptions = Required<Options>; // { debug: boolean; verbose: boolean }

// ------------------------------------------------------------
// Readonly：所有属性只读，防止被修改
// ------------------------------------------------------------
type ReadonlyUser = Readonly<User>;
const ru: ReadonlyUser = { id: 1, name: 'A', email: 'a@x.com', age: 20 };
// ru.name = 'B'; // ❌ 只读

// ------------------------------------------------------------
// Pick：从类型里「挑出」部分属性，组成新类型
// ------------------------------------------------------------
type UserPreview = Pick<User, 'id' | 'name'>; // { id: number; name: string }

// ------------------------------------------------------------
// Omit：从类型里「去掉」部分属性，剩下的组成新类型
// ------------------------------------------------------------
type UserWithoutId = Omit<User, 'id'>; // { name; email; age }
// 典型用途：创建新用户时还没有 id
function createUser(data: Omit<User, 'id'>): User {
  return { id: Date.now(), ...data };
}

// ------------------------------------------------------------
// Record：快速构造「固定键 → 同种值」的对象类型
// ------------------------------------------------------------
type Role = 'admin' | 'editor' | 'viewer';
type Permissions = Record<Role, boolean>; // { admin: boolean; editor: boolean; viewer: boolean }
const perms: Permissions = { admin: true, editor: true, viewer: false };

// ------------------------------------------------------------
// Exclude / Extract：在「联合类型」上做集合运算
// ------------------------------------------------------------
type T = 'a' | 'b' | 'c' | 'd';
type WithoutAB = Exclude<T, 'a' | 'b'>; // 'c' | 'd'（去掉 a、b）
type OnlyAB = Extract<T, 'a' | 'b'>; // 'a' | 'b'（保留 a、b）

// ------------------------------------------------------------
// NonNullable：去掉 null 和 undefined
// ------------------------------------------------------------
type MaybeString = string | null | undefined;
type DefinitelyString = NonNullable<MaybeString>; // string

// ------------------------------------------------------------
// ReturnType / Parameters：从函数类型里提取信息
// ------------------------------------------------------------
function makeUser(name: string, age: number) {
  return { name, age, createdAt: new Date() };
}
type MakeUserReturn = ReturnType<typeof makeUser>; // { name: string; age: number; createdAt: Date }
type MakeUserParams = Parameters<typeof makeUser>; // [name: string, age: number]

// ------------------------------------------------------------
// Awaited：剥掉 Promise，拿到最终解析类型（可处理嵌套 Promise）
// ------------------------------------------------------------
type P = Promise<Promise<number>>;
type Resolved = Awaited<P>; // number

console.log('=== 第 10 课：工具类型 ===');
const u: User = { id: 1, name: 'Alice', email: 'a@x.com', age: 30 };
console.log('updateUser =', updateUser(u, { age: 31 }));
console.log('createUser =', createUser({ name: 'Bob', email: 'b@x.com', age: 25 }));
console.log('perms =', perms);
const params: MakeUserParams = ['Carol', 28];
console.log('makeUser(...params) =', makeUser(...params));
console.log({ ru });

// 让本文件成为独立模块：每个 .ts 文件都有独立作用域，避免与其它课程文件的同名声明在全局冲突。
export {};
