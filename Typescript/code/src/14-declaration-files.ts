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

// node:assert/strict 是 Node 内置的断言模块，运行时校验“值是否符合预期”。
// 注意它与上面的“类型声明”正相反：assert 跑在运行时，声明只活在编译期。
import assert from 'node:assert/strict';

// checker 读取 string-tools.d.ts；运行时加载 string-tools.js。
// `.js` 后缀对源码与 dist 都诚实：TS 解析阶段会做扩展名替换找到同名 .d.ts。
// 下面这一组 import 的“类型来源”和“运行时来源”是两个不同文件：
//   - 类型由 src/legacy/string-tools.d.ts 提供（手写声明，可能说谎）；
//   - 实现由 src/legacy/string-tools.js 提供（运行时真正执行的代码）。
// 配合 tsconfig 的 moduleResolution: "Bundler"，写 .js 后缀也能正确解析。
import {
  LIB_NAME,
  misdeclaredVersionCode,
  repeat,
  shout,
} from './legacy/string-tools.js';
// 从真实实现模块导入：TraceContext 的“原始形状”（只有 runId）来自这里，
// 相邻的 trace-context.augmentation.d.ts 通过 module augmentation 合并 tenantId。
// 这里同时演示两种用法：
//   - 普通值导入 describeTrace（运行时函数，会执行）；
//   - `type TraceContext` 仅导入类型，verbatimModuleSyntax 要求显式标注 type，
//     emit 后这一条会被完全擦除，不进入运行时。
import {
  describeTrace,
  type TraceContext,
} from './14-declarations/trace-context.js';

// 以下三条 assert 校验的是“声明的形状与运行时行为一致”的常规情况。
// LIB_NAME 在 .d.ts 里被声明为字面量 'string-tools'，运行时 .js 也导出同值。
assert.equal(LIB_NAME, 'string-tools');
// shout 的声明是 (text: string) => string，运行时把输入转大写并加 !。
assert.equal(shout('hello'), 'HELLO!');
// repeat 的声明是 (text: string, times: number) => string，运行时按次数拼接。
assert.equal(repeat('ab', 3), 'ab ab ab');

// 这个 if (false) 块只用于把“会被类型检查拒绝的代码”放进文件里，
// 让 @ts-expect-error 在编译期被消费（否则未使用的 expect-error 反而会报错）。
if (false) {
  // @ts-expect-error 手写声明把参数约束成 string。
  // shout 在 .d.ts 里只接受 string，传入 number 会被 checker 拒绝；
  // 但这是纯编译期行为 —— 运行时 .js 的 shout 其实能接受任何值。
  shout(123);

  // @ts-expect-error 声明只允许 number 次数。
  // 同理：repeat 的第二个参数声明为 number，传 '3' 会被编译器挡下。
  repeat('x', '3');
}

// ---------------- .d.ts 可以说谎 ----------------

// checker 相信声明，所以静态类型是 number；实际 JS 却返回 string。
//   - 编译期：misdeclaredVersionCode() 的返回类型按 .d.ts 推断为 number，
//     因此赋值给 `const claimedNumber: number` 完全合法，checker 不报错；
//   - 运行时：真正执行的是 .js 里返回 'v-next' 的那个函数，结果是一个 string。
// 两端的“事实”由不同的系统负责：声明只对 checker 说话，JS 只对 V8 说话。
const claimedNumber: number = misdeclaredVersionCode();
// 这条断言揭示了漂移：用 typeof 在运行时探测，发现真实类型是 'string'。
assert.equal(typeof claimedNumber, 'string');
// 实际返回值是字面量字符串 'v-next'，与 .d.ts 承诺的 number 完全不符。
assert.equal(claimedNumber, 'v-next');

// 这不是 TypeScript 的随机 bug，而是信任边界：类型系统从不分析任意第三方实现
// 来证明 .d.ts 正确。库作者必须用消费方测试和声明快照守住这个承诺。

// ---------------- declare global 不会创建值 ----------------

// globals.d.ts 里的 `declare global { var APP_VERSION: string }` 只扩充了
// checker 看到的全局类型环境，并不会在 globalThis 上真正创建 APP_VERSION 属性。
// 这里先反射式删除它（如果之前被某次执行设置过），让下一行的断言从干净状态开始。
Reflect.deleteProperty(globalThis, 'APP_VERSION');
// 验证初始状态：此时 globalThis 上根本没有 APP_VERSION 这个属性。
assert.equal('APP_VERSION' in globalThis, false);

// 运行时真正“创建”该全局属性：直接给 globalThis 赋值。
// 类型检查能通过，是因为 globals.d.ts 已经告诉 checker “globalThis.APP_VERSION 是 string”，
// 但属性的存在与否仍由这次赋值决定 —— 声明不会替你执行任何赋值。
globalThis.APP_VERSION = '2.0.0';
assert.equal(globalThis.APP_VERSION, '2.0.0');

if (false) {
  // @ts-expect-error globals.d.ts 将该全局属性声明为 string。
  // 把 number 赋给 string 类型的全局属性，会被 checker 拒绝；
  // 这同样只是编译期保护，运行时若绕过 TS 直接写 JS 仍能赋值。
  globalThis.APP_VERSION = 2;
}

// ---------------- module augmentation 合并已有声明 ----------------

// TraceContext 原始模块只有 runId；相邻 augmentation.d.ts 合并了 tenantId。
//   - 原始接口（trace-context.ts）：`interface TraceContext { readonly runId: string }`；
//   - 扩充（trace-context.augmentation.d.ts）：`declare module '...' { interface TraceContext { readonly tenantId?: string } }`；
//   - checker 把两者按 declaration merging 合并成一个 interface，因此一个对象字面量
//     既能写 runId 也能写 tenantId，且都在静态类型层面被认可。
// 注意 tenantId 是可选的（?），所以缺少它时仍类型合法。
const trace: TraceContext = {
  runId: 'run-42',
  tenantId: 'tenant-cn',
};
// describeTrace 的实现里读取了 context.tenantId —— 这个字段“属于”扩充后的形状，
// 但实现模块的 .ts 源码本身并未声明它。能这样写是因为 augmentation.d.ts 被本程序纳入，
// checker 在检查 trace-context.ts 时也看得到合并后的 interface。
assert.equal(describeTrace(trace), 'run=run-42,tenant=tenant-cn');

if (false) {
  // @ts-expect-error augmentation 没有放宽原接口的必填 runId。
  // 合并是“累加”，不会消除原始成员：runId 仍是必填，少了它就报错。
  const missingRunId: TraceContext = { tenantId: 'tenant-cn' };
  console.log(missingRunId);
}

console.log('=== 第 14 课：声明文件的信任边界 ===');
// 这段输出把“声明承诺的类型”与“运行时实际类型”并排展示：
//   declaredType: 'number' 是 .d.ts 上的承诺；
//   runtimeType: typeof claimedNumber 是 V8 真正看到的类型。
// 两者不一致，正是声明文件“可以说谎”的直观证据。
console.log({
  library: LIB_NAME,
  shout: shout('typescript'),
  repeated: repeat('agent', 2),
  declaredType: 'number',
  runtimeType: typeof claimedNumber,
  globalVersion: globalThis.APP_VERSION,
  trace: describeTrace(trace),
});

// 文件末尾的 export {} 把本文件标记为“模块”而非“全局脚本”，
// 这样顶层 import 才合法，也避免顶层声明污染全局命名空间。
export {};
