/**
 * Barrel 只是重导出图中的一个普通模块，不是零成本的“目录别名”。
 * `export *` 不转发 default，因此 default 必须显式改名重导出。
 */

// 值再导出：把这些标识符从 math-utils 透传出去，barrel 自身没有创建新的实现。
// 注意 specifier 写的是 `./math-utils.js` 而非 `.ts`：源码运行时由 checker 把 .js 映射回 .ts，
// 编译产物里则原样指向 dist/.../math-utils.js，一份 specifier 同时诚实地服务两种运行模式。
export {
  PI,
  add,
  calculate,
  multiply,
  operations,
  subtract,
} from './math-utils.js';

// 类型再导出：`export { } from` 默认只搬运值，type-only 的 Operation 必须用
// `export type { }` 显式声明，否则这里会报“找不到 Operation 这个值”。
// emit 后这一行整个消失，运行时 barrel 不会为 Operation 创建任何绑定。
export type { Operation } from './math-utils.js';

// default 改名重导出：`export * from './user-model.js'` 不会转发 default 槽，
// 必须显式 `export { default as UserModel }`，把 user-model 的 default 映射成
// barrel 的命名槽 UserModel——这正是 11-modules.ts 里 BarrelUserModel 的来源。
export { default as UserModel } from './user-model.js';

// 类型再导出：把 user-model 的 UserView 接口（仅类型空间）透传到 barrel。
export type { UserView } from './user-model.js';

// 把 runtime-state 的可变绑定也按原样再导出。
// 关键点：再导出不会形成快照，runtime-state 内部修改 sharedCounter 后，
// 经 barrel 这一层导入的调用方读到的仍是最新值（live binding 跨 barrel 仍成立）。
export {
  advanceSharedCounter,
  sharedCounter,
} from './runtime-state.js';
