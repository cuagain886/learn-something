/** 真实实现模块：基础接口只知道 runId。 */
export interface TraceContext {
  readonly runId: string;
}

export function describeTrace(context: TraceContext): string {
  // tenantId 来自相邻 .d.ts 的 module augmentation；字段是 optional，
  // 因此没有该扩充文件时实现仍保持运行时兼容。
  return context.tenantId === undefined
    ? `run=${context.runId}`
    : `run=${context.runId},tenant=${context.tenantId}`;
}
