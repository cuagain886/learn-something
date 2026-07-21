// transport.ts：传输层抽象 + stdio framing + 内存实现。
//
// 分层定位：
//   - 本文件只关心“消息的字节边界与可达性”，不知道 JSON-RPC 语义；
//   - 上层的 client/server 负责把 message 解码成 request/response 并做关联；
//   - jsonrpc.ts 提供单条 message 的编解码原语（encodeJsonRpcLine / parseJsonRpcText）。
//
// RpcTransport 是协议层对“底层 IO 是 stdio/SSE/WebSocket/内存”的唯一抽象点。
import {
  encodeJsonRpcLine,
  type JsonRpcMessage,
  parseJsonRpcText,
} from './jsonrpc.js';

// Unsubscribe：transport 监听器的取消订阅句柄。调用后 listener 不再被触发。
// 与 EventTarget.removeListener 不同，这里返回函数是为了让 client/server 用统一 RAII 风格管理订阅。
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

// MemoryPair：createMemoryTransportPair 的返回类型——一对互联的内存 transport。
// 用于 demo / test：把 client 和 server 放在同一进程里直接通信。
type MemoryPair = {
  readonly client: RpcTransport;
  readonly server: RpcTransport;
};

// MemoryTransport：进程内 transport 实现。
// 与真实 stdio/SSE 的关键区别：消息不离开内存，但仍模拟“进程边界”语义（快照、异步交付）。
class MemoryTransport implements RpcTransport {
  // 两个 listener 集合：onMessage/onClose 支持多订阅，用 Set 去重。
  readonly #messageListeners = new Set<(raw: unknown) => void>();
  readonly #closeListeners = new Set<(reason: unknown) => void>();
  #peer: MemoryTransport | undefined;
  #closed = false;

  // connect：把两个 transport 互联。单向注入 peer 引用，send 时把消息推给 peer。
  connect(peer: MemoryTransport): void {
    if (this.#peer !== undefined) throw new Error('MemoryTransport 已连接');
    this.#peer = peer;
  }

  async send(message: JsonRpcMessage): Promise<void> {
    // 本端已关闭：拒绝写入。
    if (this.#closed) throw new TransportClosedError('本地 transport 已关闭');
    const peer = this.#peer;
    // 对端不存在或已关闭：等价于 broken pipe。
    if (peer === undefined || peer.#closed) {
      throw new TransportClosedError('远端 transport 已关闭');
    }

    // 模拟真正的进程/网络边界：发送方后续修改对象不会改变接收方看到的消息。
    const snapshot: unknown = structuredClone(message);
    // queueMicrotask：异步交付，模拟真实 IO 的“非立即到达”。
    // send 的 Promise 在 peer 成功 deliver 后 resolve，给调用方 backpressure 信号。
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

  // onMessage：注册消息监听器，返回取消订阅函数。
  // 已关闭时返回 no-op 解订阅——避免 close 后注册的 listener 永远挂着。
  onMessage(listener: (raw: unknown) => void): Unsubscribe {
    if (this.#closed) return () => undefined;
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }

  // onClose：注册关闭监听器。已关闭时异步触发 listener（保持“终态可观察”语义）。
  onClose(listener: (reason: unknown) => void): Unsubscribe {
    if (this.#closed) {
      queueMicrotask(() => listener(new TransportClosedError('transport 已关闭')));
      return () => undefined;
    }
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  // close：本端关闭 + 联动关闭对端（模拟 TCP 半关闭语义的简化版）。
  async close(reason: unknown = new TransportClosedError('主动关闭')): Promise<void> {
    if (this.#closed) return;
    this.#finishClose(reason);
    const peer = this.#peer;
    if (peer !== undefined) peer.#finishClose(reason);
  }

  // #deliver：peer 调用此方法把消息推给本端 listener。
  #deliver(raw: unknown): void {
    if (this.#closed) return;
    // 快照保证 listener 在本轮分发时增删订阅不会改变当前接收集合。
    for (const listener of [...this.#messageListeners]) listener(raw);
  }

  // #finishClose：单次幂等的关闭流程。清空 listener、触发 close 事件。
  #finishClose(reason: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#messageListeners.clear();
    for (const listener of [...this.#closeListeners]) listener(reason);
    this.#closeListeners.clear();
  }
}

// createMemoryTransportPair：工厂函数——构造一对互联的 MemoryTransport。
// 返回 { client, server } 让协议层各取一端。
export function createMemoryTransportPair(): MemoryPair {
  const client = new MemoryTransport();
  const server = new MemoryTransport();
  client.connect(server);
  server.connect(client);
  return { client, server };
}

// TransportClosedError：transport 层的错误类型。
// 与协议层（client.ts）的 RpcConnectionClosedError 区分：transport 不知道上层语义。
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
  // TextDecoder fatal:true：遇到非法 UTF-8 字节序列立刻抛错，而不是替换成 U+FFFD。
  // 避免“错误字节被静默吞掉”导致的协议歧义。
  readonly #decoder = new TextDecoder('utf-8', { fatal: true });
  #buffer = '';
  #finished = false;

  // maxLineCharacters：单行字符上限。防止恶意对端发送超长行导致内存爆炸。
  constructor(readonly maxLineCharacters = 1_000_000) {
    if (!Number.isSafeInteger(maxLineCharacters) || maxLineCharacters < 1) {
      throw new RangeError('maxLineCharacters 必须是正安全整数');
    }
  }

  // push：喂入一段 bytes，可能产出 0..N 条完整消息。
  // stream:true 让 TextDecoder 保留跨 chunk 的不完整 UTF-8 多字节序列，保证中文等字符被拆字节也能正确还原。
  push(chunk: Uint8Array): readonly JsonRpcMessage[] {
    if (this.#finished) throw new Error('decoder finish 后不能继续 push');
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    return this.#drainLines();
  }

  // finish：流结束。刷新 decoder 残留，校验最后没有半截消息。
  // 如果 buffer 非空 → 说明最后一条消息缺少换行 → 抛错。
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

  // #drainLines：从 buffer 里逐个找 '\n'，切出完整行解析。
  // 行长检查在解析前——避免先 parse 一个超长字符串导致 OOM。
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
      // 兼容 CRLF：剥掉行尾的 '\r'（部分 Windows/HTTP 环境会发 CRLF）。
      if (line.endsWith('\r')) line = line.slice(0, -1);
      // 空行 = 协议错误（JSON-RPC stdio 不允许心跳/分隔用的空行）。
      if (line.length === 0) throw new Error('stdio 不允许空消息行');
      messages.push(parseJsonRpcText(line));
    }
    // 残留 buffer（未遇到换行的部分）也要做长度检查，防止“永不换行”式攻击。
    if (this.#buffer.length > this.maxLineCharacters) {
      throw new RangeError('stdio 未完成 JSON-RPC message 超过字符上限');
    }
    return messages;
  }
}

// encodeForStdio：把 message 编码成 stdio 帧的字节序列。
// 复用 encodeJsonRpcLine（含 wire 校验 + LF 拼接），再 UTF-8 编码。
export function encodeForStdio(message: JsonRpcMessage): Uint8Array {
  return new TextEncoder().encode(encodeJsonRpcLine(message));
}
