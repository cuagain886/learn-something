/**
 * ESM 实例在同一个 Realm 中按“规范化后的 URL”缓存。
 *
 * 导出的 `let` 不是值快照，而是 live binding：任何导入者读到的都是当前值。
 * 这也意味着模块级可变状态天然是进程内共享状态，测试与 Agent 多 run 隔离时要谨慎。
 */

// export let：模块级可变绑定。内存里只有一份 sharedCounter，
// 所有导入它的模块共享同一个槽位——这是 live binding 的物理基础。
// 注意：调用方 `import { sharedCounter }` 拿到的是“指向该绑定的引用”，不是当时的值拷贝。
export let sharedCounter = 0;

// advanceSharedCounter：递增上面的 sharedCounter 并返回新值。
// 关键点：调用方之后再去读 `sharedCounter`，会看到 +1 后的最新值，
// 而不是 import 那一刻拍下来的 0——这是本模块想要演示的核心事实。
export function advanceSharedCounter(): number {
  sharedCounter += 1;
  return sharedCounter;
}
