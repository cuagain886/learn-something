// async-queue.ts：把 Runner 内部产生的事件投递给外部订阅者。
//
// 为什么不用 Node 的 EventEmitter 或现成 stream：
//   - Runner 一次只对应一个订阅者（控制流+事件流分两条通道）；
//   - 需要同时表达“生产者 push / 消费者 await / close 终止 / fail 错误终止”四件事；
//   - 用 AsyncIterable + AsyncIterator 让消费侧可以用 `for await ... of` 优雅拉取。
//
// 关键不变量：
//   - 单消费者：第二次取 [Symbol.asyncIterator] 会抛；
//   - push 在已关闭/失败/分离后返回 false，让生产者知道不必再投；
//   - return()（for-await 提前 break）只让观察者脱离，不取消 Run（取消走 AbortSignal）。
/** 一个等待 next() 的消费者。队列只支持单消费者，正好对应一个 Run 的事件订阅。 */
// Waiter：把 Promise 的 resolve/reject 暂存下来。生产者拿到 waiter 就能直接 resolve，
// 不需要把值先进队列再让消费者轮询——这是“快路径优化”。
type Waiter<Value> = {
  readonly resolve: (result: IteratorResult<Value>) => void;
  readonly reject: (reason: unknown) => void;
};

/**
 * 最小 AsyncIterable 事件队列。
 *
 * 生产者通过 push/close/fail 写入；消费者通过 for-await-of 拉取。若消费者慢，值会暂存
 * 在队列中，因此生产系统还需要容量上限或持久化事件总线。本实现保留最小机制以便学习。
 */
// 同时实现 AsyncIterable<Value> 和 AsyncIterator<Value>：
//   - AsyncIterable 要求有 [Symbol.asyncIterator]()；
//   - AsyncIterator 要求有 next()/return()。
// 两个接口合并到同一对象，让 for-await 直接拿 this 作为迭代器，避免一层包装。
export class AsyncQueue<Value> implements AsyncIterable<Value>, AsyncIterator<Value> {
  // 用包装对象区分“队列为空”和“队列中合法的 undefined 值”，保持泛型对任意 Value 正确。
  // 如果直接存 Value[]，遇到 Value = undefined 时无法判断 shift() 出的 undefined 是“没值”还是“值就是 undefined”。
  // 包装一层 { value } 后，shift() 返回 undefined 一定代表“队列空”。
  readonly #values: Array<{ readonly value: Value }> = [];
  // #waiters：生产者快路径。push 时优先把值直接 resolve 给等待中的消费者，绕过队列。
  readonly #waiters: Array<Waiter<Value>> = [];
  // 状态机标志：#closed 表示正常结束、#hasFailed 表示异常结束、#consumerDetached 表示消费者已 break。
  // 三者互斥但都用 boolean 而非 union：实现简单，外部只关心“是否还能 push/next”。
  #closed = false;
  #failure: unknown;
  #hasFailed = false;
  #consumerDetached = false;
  // 单消费者令牌：[Symbol.asyncIterator] 第一次调用时置 true，再次调用直接抛。
  #iteratorClaimed = false;

  /**
   * push：生产者入口。
   *
   *   - 优先匹配正在等待的消费者（waiter.resolve），实现零拷贝快路径；
   *   - 没有消费者就压入 #values 暂存，等下一次 next() 拉走；
   *   - 已 close/fail/detach 后 push 返回 false，让生产者（Runner）知道“无需再投递”。
   */
  push(value: Value): boolean {
    if (this.#closed || this.#hasFailed || this.#consumerDetached) return false;

    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter.resolve({ done: false, value });
    else this.#values.push({ value });
    return true;
  }

  /**
   * close：正常结束队列。
   *
   * 幂等：重复 close 不会重复触发 done。
   * 把所有还在等待的消费者唤醒成 done=true，让 for-await 自然结束。
   */
  close(): void {
    if (this.#closed || this.#hasFailed) return;
    this.#closed = true;
    this.#resolveDone();
  }

  /**
   * fail：异常结束。
   *
   * 与 close 的区别：所有还在等待的消费者会收到 reject(reason)，而不是 done。
   * 这样订阅方用 try/catch 包住 for-await 时能拿到错误原因——对应 Runner 的 'failed' outcome。
   */
  fail(reason: unknown): void {
    if (this.#closed || this.#hasFailed) return;
    this.#hasFailed = true;
    this.#failure = reason;

    // splice(0) 一次性清空 waiters 数组并返回原内容，避免在循环中修改正在迭代的数组。
    for (const waiter of this.#waiters.splice(0)) waiter.reject(reason);
  }

  /**
   * next：消费者拉取下一个事件。
   *
   * 三条路径，按“快路径优先”排列：
   *   1) 队列里有值 -> 立刻 Promise.resolve 一个 { done:false, value }；
   *   2) 已经 fail -> Promise.reject 把错误抛给消费者；
   *   3) 已经 close 或 detached -> 返回 done=true 结束迭代；
   *   4) 否则进入“等待”：把 resolve/reject 暂存进 #waiters，等 push/close/fail 唤醒。
   */
  next(): Promise<IteratorResult<Value>> {
    const queued = this.#values.shift();
    if (queued !== undefined) return Promise.resolve({ done: false, value: queued.value });
    if (this.#hasFailed) return Promise.reject(this.#failure);
    if (this.#closed || this.#consumerDetached) {
      return Promise.resolve({ done: true, value: undefined });
    }

    // 没有 waiter 时把 Promise 的控制权交出去；生产者 push 时通过 waiter.resolve 完成。
    return new Promise<IteratorResult<Value>>((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  /** for-await 提前 break 时调用。这里只让观察者脱离，不取消 Agent Run。 */
  // return()：消费者提前 break/return 时 JS 自动调用。
  // 设计选择：只 detach 观察者、清空暂存值，不动 Runner 控制流——取消必须走 AbortSignal。
  // 这样测试可以“只看一两条事件就 break”，而 Run 仍会跑完产出 outcome。
  return(): Promise<IteratorResult<Value>> {
    this.#consumerDetached = true;
    this.#values.length = 0;
    this.#resolveDone();
    return Promise.resolve({ done: true, value: undefined });
  }

  /**
   * [Symbol.asyncIterator]：for-await 入口。
   *
   *   - 第一次调用：把 #iteratorClaimed 置 true，返回 this 作为迭代器；
   *   - 第二次调用：抛错——一个 Run 的事件流只能被一个消费者订阅。
   *
   * 为什么强制单消费者：
   *   - 多消费者会让 push 的快路径无法决定把值给谁，且语义上 Runner 的事件流是“一次性序列”；
   *   - 真正的“广播给多个订阅者”属于更上层的实现（事件总线），不在这个最小运行时范围内。
   */
  [Symbol.asyncIterator](): AsyncIterator<Value> {
    if (this.#iteratorClaimed) {
      throw new Error('AsyncQueue 只支持一个事件消费者');
    }
    this.#iteratorClaimed = true;
    return this;
  }

  /**
   * #resolveDone：私有辅助——把所有等待中的消费者一次性唤醒成 done。
   *
   * close() 和 return() 都需要这个动作。把 waiters 数组清空（splice(0) 返回原内容），
   * 然后对每个 waiter resolve 一个 done=true。
   */
  #resolveDone(): void {
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }
}
