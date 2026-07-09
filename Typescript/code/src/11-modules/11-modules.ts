/**
 * ============================================================
 * 第 11 课：模块（Modules / import & export）
 * ============================================================
 * 本节学什么：
 *   1. 命名导入（named import）与重命名 as
 *   2. 默认导入（default import）
 *   3. 全部导入为命名空间 * as
 *   4. 仅导入类型 import type
 *   5. 重导出 export ... from（聚合多个模块）
 *
 * 运行：  npx tsx src/11-modules/11-modules.ts
 *
 * 模块基础知识：
 *   - 每个 .ts 文件就是一个独立模块，文件内的东西默认对外不可见。
 *   - 想让别的文件用，就 export；想用别人的，就 import。
 *   - 本项目用 Bundler 解析策略，相对导入可以省略扩展名（'./math-utils'）。
 */

// 1. 命名导入：用 { } 按名字精确导入；可用 as 重命名避免冲突。
import { add, subtract, PI as MathPI } from './math-utils';

// 2. 默认导入：不带 { }，名字可自定义（这里叫 UserModel）。
//    同一条语句里可以同时引入默认导出和命名导出。
import UserModel, { type IUser } from './user-model';

// 3. 命名空间导入：把一个模块的所有命名导出收进一个对象。
import * as MathUtils from './math-utils';

// 4. import type：只导入「类型」。它在编译后会被完全擦除，
//    明确表达「这只是类型，不会产生运行时依赖」，对打包更友好。
import type { Operation } from './math-utils';

const op: Operation = 'add';

const user: IUser = { id: 1, name: 'Alice' };
const model = new UserModel(2, 'Bob');

console.log('=== 第 11 课：模块 ===');
console.log('add(2,3) =', add(2, 3));
console.log('subtract(5,2) =', subtract(5, 2));
console.log('PI =', MathPI);
console.log('命名空间 MathUtils.multiply(3,4) =', MathUtils.multiply(3, 4));
console.log('op =', op);
console.log('user =', user);
console.log('model.describe() =', model.describe());

// 5. 重导出（re-export）：常见于「入口文件 index.ts」，把多个子模块聚合成一个出口。
//    示例（这里仅注释说明语法，不实际重导出）：
//    export { add, subtract } from './math-utils';
//    export { default as UserModel } from './user-model';
//    export * from './math-utils'; // 转发全部命名导出
