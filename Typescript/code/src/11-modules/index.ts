/**
 * Barrel 只是重导出图中的一个普通模块，不是零成本的“目录别名”。
 * `export *` 不转发 default，因此 default 必须显式改名重导出。
 */

export {
  PI,
  add,
  calculate,
  multiply,
  operations,
  subtract,
} from './math-utils.js';
export type { Operation } from './math-utils.js';

export { default as UserModel } from './user-model.js';
export type { UserView } from './user-model.js';

export {
  advanceSharedCounter,
  sharedCounter,
} from './runtime-state.js';
