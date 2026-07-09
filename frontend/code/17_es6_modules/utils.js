// utils.js —— 另一个模块，用于演示跨模块导入

import sum, { PI, add } from './math.js';

export function circleArea(radius) {
    return PI * radius * radius;
}

export function calculate() {
    console.log('utils 模块中调用了 math.js:');
    console.log('  add(5, 3) =', add(5, 3));
    console.log('  sum(1,2,3,4,5) =', sum(1, 2, 3, 4, 5));
    console.log('  PI =', PI);
}
