/**
 * ============================================================
 * 第 15 课：综合实战 —— 类型安全的事件系统（Typed EventEmitter）
 * ============================================================
 * 本节目标：把前面学的知识串起来做一个真实小项目：
 *   - 泛型（第 07 课）
 *   - keyof / 索引访问类型 / 映射类型（第 09 课）
 *   - 接口、类型别名、联合类型（第 04、05 课）
 *   - 类（第 06 课）
 *
 * 我们实现一个「事件发布订阅」：on 订阅、emit 触发、off 取消。
 * 关键在于：事件名和它的「数据负载类型」是绑定的，传错数据编译期就报错。
 *
 * 运行：  npx tsx src/15-practice.ts
 */

// ------------------------------------------------------------
// 第 1 步：用一个「事件名 → 负载类型」的映射来描述所有事件
// ------------------------------------------------------------
// 注意：这里用 type 而不是 interface。
// 原因是下面 TypedEmitter 的泛型约束是 Record<string, unknown>，
// 而 interface 不带「隐式索引签名」，无法满足这个约束；type 定义的对象类型则可以。
// 这是一个非常常见的真实陷阱，值得记住。
type AppEvents = {
  login: { userId: number; at: Date };
  logout: { userId: number };
  message: { from: number; text: string };
};

// 每个事件对应的「处理函数」类型：接收该事件的负载，无返回值。
type Listener<T> = (payload: T) => void;

// ------------------------------------------------------------
// 第 2 步：实现泛型事件发射器
// ------------------------------------------------------------
// Events 是一个「事件名 → 负载类型」的对象类型。
class TypedEmitter<Events extends Record<string, unknown>> {
  // 用映射类型存每个事件的监听器数组。? 表示某事件可能还没有任何监听器。
  private listeners: {
    [K in keyof Events]?: Array<Listener<Events[K]>>;
  } = {};

  // on：订阅。K 被约束为 Events 的某个键，handler 的参数类型自动对应 Events[K]。
  on<K extends keyof Events>(event: K, handler: Listener<Events[K]>): void {
    // 若该事件还没有数组，先建一个
    (this.listeners[event] ??= []).push(handler);
  }

  // off：取消订阅
  off<K extends keyof Events>(event: K, handler: Listener<Events[K]>): void {
    const arr = this.listeners[event];
    if (!arr) return;
    this.listeners[event] = arr.filter((h) => h !== handler);
  }

  // emit：触发。payload 的类型必须与事件名匹配，否则编译报错。
  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    this.listeners[event]?.forEach((handler) => handler(payload));
  }
}

// ------------------------------------------------------------
// 第 3 步：使用它 —— 注意全程都有类型提示与检查
// ------------------------------------------------------------
const bus = new TypedEmitter<AppEvents>();

bus.on('login', (p) => {
  // p 被自动推断为 { userId: number; at: Date }
  console.log(`用户 ${p.userId} 在 ${p.at.toISOString()} 登录`);
});

bus.on('message', (p) => {
  console.log(`来自 ${p.from} 的消息: ${p.text}`);
});

console.log('=== 第 15 课：综合实战（类型安全事件系统）===');
bus.emit('login', { userId: 1, at: new Date('2024-01-01T00:00:00Z') });
bus.emit('message', { from: 1, text: '你好，TypeScript!' });

// 下面这些「错误用法」如果取消注释，都会在编译期被拦截 —— 这正是类型系统的价值：
// bus.emit('login', { userId: 'abc', at: new Date() }); // ❌ userId 应为 number
// bus.emit('logout', { text: 'hi' });                   // ❌ 负载形状不匹配
// bus.on('unknownEvent', () => {});                     // ❌ 不存在的事件名

/*
 * ============================================================
 * 练习题（TODO）—— 试着自己实现，再对照下面的参考答案
 * ============================================================
 *
 * TODO 1：给 TypedEmitter 增加一个 once 方法，
 *         让监听器只触发一次，之后自动取消订阅。
 *
 * TODO 2：增加一个 listenerCount(event) 方法，
 *         返回某事件当前的监听器数量（类型要安全）。
 *
 * TODO 3：给 AppEvents 增加一个新事件 'error'，负载是 { message: string }，
 *         并订阅、触发它。
 *
 *
 * ------------------------------------------------------------
 * 参考答案（建议先自己写，再看这里）
 * ------------------------------------------------------------
 *
 * // 答案 1：once
 * once<K extends keyof Events>(event: K, handler: Listener<Events[K]>): void {
 *   const wrapper: Listener<Events[K]> = (payload) => {
 *     this.off(event, wrapper); // 先取消，再执行，确保只触发一次
 *     handler(payload);
 *   };
 *   this.on(event, wrapper);
 * }
 *
 * // 答案 2：listenerCount
 * listenerCount<K extends keyof Events>(event: K): number {
 *   return this.listeners[event]?.length ?? 0;
 * }
 *
 * // 答案 3：在 AppEvents 类型里加：
 * //   error: { message: string };
 * // 然后：
 * //   bus.on('error', (p) => console.error(p.message));
 * //   bus.emit('error', { message: '出错了' });
 */

// 让本文件成为独立模块：每个 .ts 文件都有独立作用域，避免与其它课程文件的同名声明在全局冲突。
export {};
