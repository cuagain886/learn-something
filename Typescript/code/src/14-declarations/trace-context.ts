/** 真实实现模块：基础接口只知道 runId。 */
// 本文件是“带运行时实现的 .ts 模块”，与纯声明文件（.d.ts）相对：
//   - 它既参与 checker（提供 TraceContext 接口、describeTrace 的类型签名）；
//   - 又参与运行时（describeTrace 真的会被调用，return 这一行会执行）。
// 而相邻的 trace-context.augmentation.d.ts 只在编译期扩充接口，运行时不存在。

// TraceContext 是“被扩充的目标”：原始定义只有 runId 一个字段。
// 当 augmentation.d.ts 通过 `declare module './trace-context.js'` 合并 tenantId 后，
// checker 看到的 TraceContext 实际上是两个来源的合并结果。
// 注意 interface 的 declaration merging 只对“同名 + 同位置”的 interface 生效，
// 这里 runId 是 readonly，合并不会改变它的可写性。
export interface TraceContext {
  // runId 是原始接口的必填字段：描述一次 trace/run 的唯一标识。
  // 即使没有 augmentation，runId 也必须存在，下面 describeTrace 才能安全读它。
  readonly runId: string;
}

// describeTrace 是一个普通的运行时函数，不是 declare。
// 它接收上面（被合并后的）TraceContext，返回人类可读的字符串。
// 函数签名只声明了参数类型，不依赖 augmentation 也能通过编译；
// 但函数体里读取 context.tenantId 这一步，需要 augmentation 在场才类型合法。
export function describeTrace(context: TraceContext): string {
  // tenantId 来自相邻 .d.ts 的 module augmentation；字段是 optional，
  // 因此没有该扩充文件时实现仍保持运行时兼容。
  //
  // 这里有一个微妙的设计：实现模块故意把 tenantId 当作 optional 处理（先判 === undefined），
  // 即使 augmentation 把它声明为 `readonly tenantId?: string`（也是可选），
  // 这样无论扩充文件是否被纳入编译，运行时都能稳定工作：
  //   - 有 augmentation：checker 知道 tenantId 存在且可能是 undefined，这里读取合法；
  //   - 无 augmentation：tenantId 字段在运行时根本不存在，=== undefined 也成立，分支安全。
  //
  // 注意：context.tenantId 这种“运行时属性访问”不会被 TS 抹除；
  // 但 augmentation 里新增的 interface 成员本身没有任何运行时代码 —— 它只是类型信息。
  return context.tenantId === undefined
    ? `run=${context.runId}`
    : `run=${context.runId},tenant=${context.tenantId}`;
}
