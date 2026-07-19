import {
  encodeJsonRpcLine,
  type JsonRpcMessage,
  parseJsonRpcText,
} from './jsonrpc.js';

export type Unsubscribe = () => void;

/**
 * 协议层只要求双向消息与关闭事件，不知道消息来自 stdio、HTTP/SSE 还是测试内存通道。
 * send 返回 Promise 表达 transport backpressure；把它写成 void 会丢掉写失败与 drain 时机。
 */
export interface RpcTransport {
  send(message: JsonRpcMessage): Promise<void>;
  onMessage(listener: (raw: unknown) => void): Unsubscribe;
  onClose(listener: (reason: unknown) => void): Unsubscribe;
  close(reason?: unknown): Promise<void>;
}

type MemoryPair = {
  readonly client: RpcTransport;
  readonly server: RpcTransport;
};

class MemoryTransport implements RpcTransport {
  readonly #messageListeners = new Set<(raw: unknown) => void>();
  readonly #closeListeners = new Set<(reason: unknown) => void>();
  #peer: MemoryTransport | undefined;
  #closed = false;

  connect(peer: MemoryTransport): void {
    if (this.#peer !== undefined) throw new Error('MemoryTransport 已连接');
    this.#peer = peer;
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.#closed) throw new TransportClosedError('本地 transport 已关闭');
    const peer = this.#peer;
    if (peer === undefined || peer.#closed) {
      throw new TransportClosedError('远端 transport 已关闭');
    }

    // 模拟真正的进程/网络边界：发送方后续修改对象不会改变接收方看到的消息。
    const snapshot: unknown = structuredClone(message);
    await new Promise<void>((resolve, reject) => {
      queueMicrotask(() => {
        try {
          peer.#deliver(snapshot);
          resolve();
        } catch (cause: unknown) {
          reject(cause);
        }
      });
    });
  }

  onMessage(listener: (raw: unknown) => void): Unsubscribe {
    if (this.#closed) return () => undefined;
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }

  onClose(listener: (reason: unknown) => void): Unsubscribe {
    if (this.#closed) {
      queueMicrotask(() => listener(new TransportClosedError('transport 已关闭')));
      return () => undefined;
    }
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  async close(reason: unknown = new TransportClosedError('主动关闭')): Promise<void> {
    if (this.#closed) return;
    this.#finishClose(reason);
    const peer = this.#peer;
    if (peer !== undefined) peer.#finishClose(reason);
  }

  #deliver(raw: unknown): void {
    if (this.#closed) return;
    // 快照保证 listener 在本轮分发时增删订阅不会改变当前接收集合。
    for (const listener of [...this.#messageListeners]) listener(raw);
  }

  #finishClose(reason: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#messageListeners.clear();
    for (const listener of [...this.#closeListeners]) listener(reason);
    this.#closeListeners.clear();
  }
}

export function createMemoryTransportPair(): MemoryPair {
  const client = new MemoryTransport();
  const server = new MemoryTransport();
  client.connect(server);
  server.connect(client);
  return { client, server };
}

export class TransportClosedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TransportClosedError';
  }
}

/**
 * MCP stdio framing：每个 UTF-8 JSON-RPC message 占一行，stdout 不能混入日志。
 * 本 decoder 只处理 framing；进程启动、stdin drain、stderr 与退出升级留给 transport adapter。
 */
export class StdioJsonRpcDecoder {
  readonly #decoder = new TextDecoder('utf-8', { fatal: true });
  #buffer = '';
  #finished = false;

  constructor(readonly maxLineCharacters = 1_000_000) {
    if (!Number.isSafeInteger(maxLineCharacters) || maxLineCharacters < 1) {
      throw new RangeError('maxLineCharacters 必须是正安全整数');
    }
  }

  push(chunk: Uint8Array): readonly JsonRpcMessage[] {
    if (this.#finished) throw new Error('decoder finish 后不能继续 push');
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    return this.#drainLines();
  }

  finish(): readonly JsonRpcMessage[] {
    if (this.#finished) return [];
    this.#finished = true;
    this.#buffer += this.#decoder.decode();
    const messages = this.#drainLines();
    if (this.#buffer.length > 0) {
      throw new Error('stdio 最后一条 JSON-RPC message 缺少换行 delimiter');
    }
    return messages;
  }

  #drainLines(): JsonRpcMessage[] {
    const messages: JsonRpcMessage[] = [];
    while (true) {
      const newline = this.#buffer.indexOf('\n');
      if (newline < 0) break;
      if (newline > this.maxLineCharacters) {
        throw new RangeError('stdio JSON-RPC message 超过字符上限');
      }
      let line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length === 0) throw new Error('stdio 不允许空消息行');
      messages.push(parseJsonRpcText(line));
    }
    if (this.#buffer.length > this.maxLineCharacters) {
      throw new RangeError('stdio 未完成 JSON-RPC message 超过字符上限');
    }
    return messages;
  }
}

export function encodeForStdio(message: JsonRpcMessage): Uint8Array {
  return new TextEncoder().encode(encodeJsonRpcLine(message));
}
