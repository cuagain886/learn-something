/**
 * ============================================================
 * 第 13 课：装饰器（Decorators，TS 5+ 标准装饰器）
 * ============================================================
 * 本节学什么：
 *   1. 什么是装饰器
 *   2. 方法装饰器
 *   3. 装饰器工厂（带参数的装饰器）
 *   4. 字段装饰器
 *   5. 类装饰器
 *   6. 用 context.addInitializer 自动绑定 this
 *
 * 运行：  npx tsx src/13-decorators.ts
 *
 * 重要说明：
 *   - 本文件用的是 TC39「标准装饰器」（TypeScript 5.0+ 默认支持），
 *     无需在 tsconfig 里开启 experimentalDecorators。
 *   - 装饰器是「用 @xxx 贴在类、方法、字段上」的函数，能在「定义阶段」
 *     拦截/增强这些成员。常见于框架（Angular、NestJS 等）。
 *   - 标准装饰器签名固定为 (value, context) 两个参数，context 描述被装饰对象的信息。
 */

// ------------------------------------------------------------
// 2. 方法装饰器：在方法前后插入日志
// ------------------------------------------------------------
// 标准方法装饰器：第一个参数是原方法，第二个是上下文。
// 返回一个「替换后的新方法」。
function log(originalMethod: any, context: ClassMethodDecoratorContext) {
  const methodName = String(context.name);
  function replacement(this: any, ...args: any[]) {
    console.log(`[LOG] 调用 ${methodName}(${args.join(', ')})`);
    const result = originalMethod.call(this, ...args);
    console.log(`[LOG] ${methodName} 返回 ${result}`);
    return result;
  }
  return replacement;
}

// ------------------------------------------------------------
// 3. 装饰器工厂：先调用一个函数，返回真正的装饰器（这样能携带参数）
// ------------------------------------------------------------
function minimum(min: number) {
  // 返回的才是装饰器本体
  return function (originalMethod: any, _context: ClassMethodDecoratorContext) {
    return function (this: any, value: number) {
      // 对入参做约束：小于 min 就抬升到 min
      const safe = value < min ? min : value;
      return originalMethod.call(this, safe);
    };
  };
}

// ------------------------------------------------------------
// 4. 字段装饰器：返回一个「初始化转换函数」，用来加工字段初始值
// ------------------------------------------------------------
function uppercase(_value: undefined, _context: ClassFieldDecoratorContext) {
  // 返回的函数接收字段的初始值，返回处理后的值
  return function (initialValue: string) {
    return initialValue.toUpperCase();
  };
}

// ------------------------------------------------------------
// 6. addInitializer：在实例初始化时执行逻辑（这里把方法 this 绑定到实例）
// ------------------------------------------------------------
function bound(originalMethod: any, context: ClassMethodDecoratorContext) {
  const methodName = context.name;
  context.addInitializer(function (this: any) {
    // 实例创建时，把该方法替换为「永久绑定 this」的版本，
    // 这样即使把方法当回调单独传出去，this 也不会丢。
    this[methodName] = this[methodName].bind(this);
  });
}

// ------------------------------------------------------------
// 5. 类装饰器：贴在 class 上，可增强或替换整个类
// ------------------------------------------------------------
function withTimestamp<T extends new (...args: any[]) => object>(
  Target: T,
  _context: ClassDecoratorContext,
) {
  // 返回一个继承原类的新类，额外加一个 createdAt 字段
  return class extends Target {
    createdAt = new Date().toISOString();
  };
}

// ------------------------------------------------------------
// 把上面这些装饰器用起来
// ------------------------------------------------------------
@withTimestamp
class Calculator {
  @uppercase
  label = 'calc'; // 初始化时会被转成 'CALC'

  @log
  add(a: number, b: number): number {
    return a + b;
  }

  @minimum(0)
  setLevel(level: number): number {
    return level; // 经 @minimum(0) 处理，负数会被抬升为 0
  }

  @bound
  greet(): string {
    return `Hello from ${this.label}`;
  }
}

console.log('=== 第 13 课：装饰器 ===');
const calc = new Calculator();
console.log('label =', calc.label); // 'CALC'（被 @uppercase 转换）
calc.add(2, 3); // 触发 @log 的前后日志
console.log('setLevel(-5) =', calc.setLevel(-5)); // 0（被 @minimum(0) 抬升）

// @bound 的效果：把方法单独取出来调用，this 依然正确
const detached = calc.greet;
console.log('detached() =', detached());

// @withTimestamp 给类加上了 createdAt
console.log('createdAt =', (calc as any).createdAt);

// 让本文件成为独立模块：每个 .ts 文件都有独立作用域，避免与其它课程文件的同名声明在全局冲突。
export {};
