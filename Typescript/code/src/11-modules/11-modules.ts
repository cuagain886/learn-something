/**
 * ============================================================
 * 第 11 课：ESM 模块图、live binding 与 Node 解析
 * ============================================================
 *
 * 运行源码：npx tsx src/11-modules/11-modules.ts
 * 运行产物：npm run lesson:modules:dist
 *
 * 本课不再只背 import/export 语法，而是验证五个底层事实：
 *
 * 1. Node ESM 的相对 specifier 是 URL，必须写运行时扩展名；
 * 2. TypeScript 会用扩展名替换找到 `.ts`/`.d.ts`，但默认保留 specifier；
 * 3. 类型导入在 emit 时擦除，值导入形成真实模块图边；
 * 4. ESM 导出是 live binding，不是 CommonJS 对象属性的简单快照；
 * 5. 同一个规范化 URL 只求值一次，静态与动态 import 共享模块实例。
 *
 * 本项目使用 `moduleResolution: Bundler` 方便其它课程，但这里仍主动写 `.js`：
 * checker 会把 `./math-utils.js` 映射到源码 `.ts`，emit 后 specifier 原样指向
 * `dist/.../math-utils.js`，因此源码运行器与纯 Node dist 都诚实。
 */

// Node 内置断言模块（strict 模式），以 default 对象形式导出。
import assert from 'node:assert/strict';
// Node 内置 path 模块，下面用 basename 取当前文件名。
import path from 'node:path';
// fileURLToPath 把 file:// URL 解码成本地文件系统路径。
import { fileURLToPath } from 'node:url';

// 默认导入的本地名字可以任意选择。
// 这里直接从 user-model.js 取 default 导出（用本地名 DefaultUserModel）和类型导出 UserView。
// `type` 修饰让 UserView 只参与类型检查、不进入运行时模块图（emit 后这条 import 里没有它）。
import DefaultUserModel, { type UserView } from './user-model.js';

// 普通导入会保留为运行时依赖；同一条语句可以用 `type` 标记类型项。
// 这里同时拿到 default 改名后的 BarrelUserModel——稍后会用 strictEqual 验证它和
// 上面的 DefaultUserModel 其实指向同一个构造器值。
import {
  PI,
  UserModel as BarrelUserModel,
  add,
  advanceSharedCounter,
  calculate,
  sharedCounter,
  type Operation,
} from './index.js';

// namespace import 的运行时结果是 Module Namespace Exotic Object。
// 它把 runtime-state.js 的所有导出聚合为单个对象，但这个对象不是普通可写对象（见下方断言）。
import * as directStateNamespace from './runtime-state.js';

// Operation 类型把字面量 'multiply' 收窄为合法键，编译期就排除 'divide' 等不存在的操作。
const operation: Operation = 'multiply';
// UserView 接口作为形状契约约束 input，运行时不产生任何字段或检查。
const input: UserView = { id: 1, name: 'Alice' };
// 调用 default 导出类的静态工厂方法，从纯数据形状构造一个 UserModel 实例。
const user = DefaultUserModel.from(input);

// 验证值导入确实拿到了真实的运行时函数：add、calculate、PI 都按预期工作。
assert.equal(add(2, 3), 5);
assert.equal(calculate(operation, 3, 4), 12);
assert.equal(PI, Math.PI);
assert.equal(user.describe(), 'User#1 Alice');

// default 被 barrel 改名重导出后仍是同一个构造器值。
// default 槽与命名槽指向同一个 class 对象，没有发生拷贝。
assert.strictEqual(DefaultUserModel, BarrelUserModel);
// 既然指向同一个构造器，instanceof 自然也成立。
assert.ok(user instanceof BarrelUserModel);

// imported binding 会随导出方变化，而不是在 import 时复制为 0。
assert.equal(sharedCounter, 0);
// 调用 advanceSharedCounter 后再读 sharedCounter——
assert.equal(advanceSharedCounter(), 1);
// ——应当看到 1，而不是 import 那一刻拍下来的 0。这就是 ESM live binding 与 CommonJS 快照的关键区别。
assert.equal(sharedCounter, 1);
// 通过 namespace 对象读 sharedCounter 也是 1，证明 `import { sharedCounter }` 与
// `import * as ns` 读的是同一个绑定，并没有各自复制一份。
assert.equal(directStateNamespace.sharedCounter, 1);

// 动态 import 返回 Promise<模块命名空间对象>。同一个 URL 命中同一模块实例。
// 这里 await 拿到 runtime-state 的命名空间，并断言它和上面静态 import 的是同一对象——
// 说明同一个规范化 URL 只求值一次，静态 import 与动态 import 共享模块实例。
const dynamicStateNamespace = await import('./runtime-state.js');
assert.strictEqual(dynamicStateNamespace, directStateNamespace);
assert.equal(dynamicStateNamespace.sharedCounter, 1);

// 模块命名空间不是普通可随意写入的对象：原型为 null，添加/改写导出失败。
assert.equal(Object.getPrototypeOf(dynamicStateNamespace), null);
// Reflect.set 返回 false 表示写入失败：你不能从外部篡改模块导出的绑定。
assert.equal(Reflect.set(dynamicStateNamespace, 'sharedCounter', 99), false);
// 写入失败后值依旧是 1，再次印证 namespace 上的属性是不可改写的 live binding。
assert.equal(dynamicStateNamespace.sharedCounter, 1);

// ESM 没有 CommonJS 的 __filename；import.meta.url 才是当前模块的规范 URL。
const currentFile = fileURLToPath(import.meta.url);
// basename 取到 '11-modules.ts'（或 emit 后的 '.js'），再用正则去掉扩展名，期望得到 '11-modules'。
assert.equal(path.basename(currentFile).replace(/\.(?:ts|js)$/, ''), '11-modules');

// 负向类型契约只交给 checker 执行，不进入运行时分支。
if (false) {
  // @ts-expect-error Operation 来自 operations 的真实键，不包含 divide。
  const impossibleOperation: Operation = 'divide';

  // @ts-expect-error `import type` 得到的 UserView 不能作为构造器值使用。
  new UserView();

  console.log(impossibleOperation);
}

console.log('=== 第 11 课：ESM 模块图 ===');
console.log({
  operation,
  result: calculate(operation, 3, 4),
  user: user.toJSON(),
  sharedCounter,
  namespaceKeys: Object.keys(dynamicStateNamespace),
  currentFile,
});
