/** 一个等待 next() 的消费者。队列只支持单消费者，正好对应一个 Run 的事件订阅。 */
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
export class AsyncQueue<Value> implements AsyncIterable<Value>, AsyncIterator<Value> {
  // 用包装对象区分“队列为空”和“队列中合法的 undefined 值”，保持泛型对任意 Value 正确。
  readonly #values: Array<{ readonly value: Value }> = [];
  readonly #waiters: Array<Waiter<Value>> = [];
  #closed = false;
  #failure: unknown;
  #hasFailed = false;
  #consumerDetached = false;
  #iteratorClaimed = false;

  push(value: Value): boolean {
    if (this.#closed || this.#hasFailed || this.#consumerDetached) return false;

    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter.resolve({ done: false, value });
    else this.#values.push({ value });
    return true;
  }

  close(): void {
    if (this.#closed || this.#hasFailed) return;
    this.#closed = true;
    this.#resolveDone();
  }

  fail(reason: unknown): void {
    if (this.#closed || this.#hasFailed) return;
    this.#hasFailed = true;
    this.#failure = reason;

    for (const waiter of this.#waiters.splice(0)) waiter.reject(reason);
  }

  next(): Promise<IteratorResult<Value>> {
    const queued = this.#values.shift();
    if (queued !== undefined) return Promise.resolve({ done: false, value: queued.value });
    if (this.#hasFailed) return Promise.reject(this.#failure);
    if (this.#closed || this.#consumerDetached) {
      return Promise.resolve({ done: true, value: undefined });
    }

    return new Promise<IteratorResult<Value>>((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  /** for-await 提前 break 时调用。这里只让观察者脱离，不取消 Agent Run。 */
  return(): Promise<IteratorResult<Value>> {
    this.#consumerDetached = true;
    this.#values.length = 0;
    this.#resolveDone();
    return Promise.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<Value> {
    if (this.#iteratorClaimed) {
      throw new Error('AsyncQueue 只支持一个事件消费者');
    }
    this.#iteratorClaimed = true;
    return this;
  }

  #resolveDone(): void {
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }
}
