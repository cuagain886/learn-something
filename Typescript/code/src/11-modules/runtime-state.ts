/**
 * ESM 实例在同一个 Realm 中按“规范化后的 URL”缓存。
 *
 * 导出的 `let` 不是值快照，而是 live binding：任何导入者读到的都是当前值。
 * 这也意味着模块级可变状态天然是进程内共享状态，测试与 Agent 多 run 隔离时要谨慎。
 */

export let sharedCounter = 0;

export function advanceSharedCounter(): number {
  sharedCounter += 1;
  return sharedCounter;
}
