// main.js —— 入口文件，演示各种导入方式

// 1. 命名导入
import { add, multiply, PI } from './math.js';

// 2. 命名空间导入
import * as math from './math.js';

// 3. 默认导入
import sum from './math.js';

// 4. 从 utils 导入
import { circleArea, calculate } from './utils.js';

console.log('═══ ES6 模块导入演示 ═══');
console.log('命名导入 add(3, 4):', add(3, 4));
console.log('命名导入 multiply(5, 6):', multiply(5, 6));
console.log('命名空间 math.PI:', math.PI);
console.log('默认导入 sum(1,2,3):', sum(1, 2, 3));
console.log('utils.circleArea(5):', circleArea(5));

console.log('\n── 调用 utils.calculate() ──');
calculate();

// 5. 动态导入演示（按需加载）
// setTimeout 模拟"用户点击后才需要"的场景
setTimeout(async () => {
    console.log('\n── 动态导入（2秒后）──');
    // 实际项目中：const { default: _ } = await import('lodash');
    // 这里演示重新导入同一个模块
    const mathAgain = await import('./math.js');
    console.log('动态导入的 PI:', mathAgain.PI);
    console.log('（注意：模块只会执行一次，多次导入返回缓存的同一个实例）');
}, 2000);
