/**
 * ============================================================
 * 第 14 课：.d.ts、ambient 声明与运行时契约
 * ============================================================
 *
 * 运行源码：npx tsx src/14-declaration-files.ts
 * 运行产物：npm run lesson:declarations:dist
 *
 * 本课验证四种经常混淆的机制：
 *
 * 1. 同名 `.d.ts` 可以给无类型 JS 模块提供静态形状；
 * 2. 声明文件不会执行、不会创建变量，也不会校验 JS 实现；
 * 3. `declare global` 和 module augmentation 只是扩充已有作用域；
 * 4. `tsc` 不会自动复制任意 JS/.d.ts 资产，发布流程必须显式打包它们。
 */

import assert from 'node:assert/strict';

// checker 读取 string-tools.d.ts；运行时加载 string-tools.js。
// `.js` 后缀对源码与 dist 都诚实：TS 解析阶段会做扩展名替换找到同名 .d.ts。
import {
  LIB_NAME,
  misdeclaredVersionCode,
  repeat,
  shout,
} from './legacy/string-tools.js';
import {
  describeTrace,
  type TraceContext,
} from './14-declarations/trace-context.js';

assert.equal(LIB_NAME, 'string-tools');
assert.equal(shout('hello'), 'HELLO!');
assert.equal(repeat('ab', 3), 'ab ab ab');

if (false) {
  // @ts-expect-error 手写声明把参数约束成 string。
  shout(123);

  // @ts-expect-error 声明只允许 number 次数。
  repeat('x', '3');
}

// ---------------- .d.ts 可以说谎 ----------------

// checker 相信声明，所以静态类型是 number；实际 JS 却返回 string。
const claimedNumber: number = misdeclaredVersionCode();
assert.equal(typeof claimedNumber, 'string');
assert.equal(claimedNumber, 'v-next');

// 这不是 TypeScript 的随机 bug，而是信任边界：类型系统从不分析任意第三方实现
// 来证明 .d.ts 正确。库作者必须用消费方测试和声明快照守住这个承诺。

// ---------------- declare global 不会创建值 ----------------

Reflect.deleteProperty(globalThis, 'APP_VERSION');
assert.equal('APP_VERSION' in globalThis, false);

globalThis.APP_VERSION = '2.0.0';
assert.equal(globalThis.APP_VERSION, '2.0.0');

if (false) {
  // @ts-expect-error globals.d.ts 将该全局属性声明为 string。
  globalThis.APP_VERSION = 2;
}

// ---------------- module augmentation 合并已有声明 ----------------

// TraceContext 原始模块只有 runId；相邻 augmentation.d.ts 合并了 tenantId。
const trace: TraceContext = {
  runId: 'run-42',
  tenantId: 'tenant-cn',
};
assert.equal(describeTrace(trace), 'run=run-42,tenant=tenant-cn');

if (false) {
  // @ts-expect-error augmentation 没有放宽原接口的必填 runId。
  const missingRunId: TraceContext = { tenantId: 'tenant-cn' };
  console.log(missingRunId);
}

console.log('=== 第 14 课：声明文件的信任边界 ===');
console.log({
  library: LIB_NAME,
  shout: shout('typescript'),
  repeated: repeat('agent', 2),
  declaredType: 'number',
  runtimeType: typeof claimedNumber,
  globalVersion: globalThis.APP_VERSION,
  trace: describeTrace(trace),
});

export {};
