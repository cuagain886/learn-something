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

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 默认导入的本地名字可以任意选择。
import DefaultUserModel, { type UserView } from './user-model.js';

// 普通导入会保留为运行时依赖；同一条语句可以用 `type` 标记类型项。
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
import * as directStateNamespace from './runtime-state.js';

const operation: Operation = 'multiply';
const input: UserView = { id: 1, name: 'Alice' };
const user = DefaultUserModel.from(input);

assert.equal(add(2, 3), 5);
assert.equal(calculate(operation, 3, 4), 12);
assert.equal(PI, Math.PI);
assert.equal(user.describe(), 'User#1 Alice');

// default 被 barrel 改名重导出后仍是同一个构造器值。
assert.strictEqual(DefaultUserModel, BarrelUserModel);
assert.ok(user instanceof BarrelUserModel);

// imported binding 会随导出方变化，而不是在 import 时复制为 0。
assert.equal(sharedCounter, 0);
assert.equal(advanceSharedCounter(), 1);
assert.equal(sharedCounter, 1);
assert.equal(directStateNamespace.sharedCounter, 1);

// 动态 import 返回 Promise<模块命名空间对象>。同一个 URL 命中同一模块实例。
const dynamicStateNamespace = await import('./runtime-state.js');
assert.strictEqual(dynamicStateNamespace, directStateNamespace);
assert.equal(dynamicStateNamespace.sharedCounter, 1);

// 模块命名空间不是普通可随意写入的对象：原型为 null，添加/改写导出失败。
assert.equal(Object.getPrototypeOf(dynamicStateNamespace), null);
assert.equal(Reflect.set(dynamicStateNamespace, 'sharedCounter', 99), false);
assert.equal(dynamicStateNamespace.sharedCounter, 1);

// ESM 没有 CommonJS 的 __filename；import.meta.url 才是当前模块的规范 URL。
const currentFile = fileURLToPath(import.meta.url);
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
