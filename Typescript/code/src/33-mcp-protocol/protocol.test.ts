// protocol.test.ts：JSON-RPC / MCP 协议实现的运行时测试。
//
// 测试分两类：
//   - 运行时测试（test(...)）：用 ManualTransport / MemoryTransport 驱动真实状态机，验证 wire 行为；
//   - 负向类型测试（@ts-expect-error）：证明 method name → params/result 的泛型相关性在编译期成立。
//
// ManualTransport 是测试专用的 RpcTransport：把 send 暂存、inject 模拟远端回包、remoteClose 模拟断连。
import assert from 'node:assert/strict';
import test from 'node:test';

import { number, object, string } from '../17-schema.js';
import {
  JsonRpcClient,
  RpcConnectionClosedError,
  RpcProtocolViolationError,
  RpcRemoteError,
  RpcRequestCancelledError,
} from './client.js';
import { RpcPayloadValidationError } from './codec.js';
import {
  decodeJsonRpcMessage,
  encodeJsonRpcLine,
  type JsonRpcMessage,
  parseJsonRpcText,
} from './jsonrpc.js';
import {
  defineMcpTool,
  McpClientSession,
  McpLifecycleError,
  mcpMethodSchemas,
  McpServerSession,
  MCP_PROTOCOL_VERSION,
} from './mcp.js';
import {
  createMemoryTransportPair,
  encodeForStdio,
  type RpcTransport,
  StdioJsonRpcDecoder,
  type Unsubscribe,
} from './transport.js';

// calculatorMethods：一个最小 method table，供 JsonRpcClient 单元测试使用。
// multiply 的 params/result 都是固定结构，便于断言。
const calculatorMethods = {
  multiply: {
    params: object({ left: number(), right: number() }),
    result: object({ value: number() }),
  },
} as const;

// 第 1 组：wire 解码器层面的不变量——字段互斥、id 类型、不执行 getter、有限数字。
test('wire decoder 强制 request/notification/response 互斥，并且不执行 getter', () => {
  // 合法 request：应通过。
  const request = decodeJsonRpcMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'multiply',
    params: { left: 2, right: 3 },
  });
  assert.equal(request.ok, true);

  // 同时包含 result 与 error：违反互斥，必须失败。
  const both = decodeJsonRpcMessage({
    jsonrpc: '2.0',
    id: 1,
    result: 6,
    error: { code: -32603, message: 'impossible' },
  });
  assert.equal(both.ok, false);
  if (!both.ok) assert.match(both.issues[0]?.message ?? '', /只能包含/u);

  // request 的 id 为 null：MCP 比 JSON-RPC 更严，拒绝。
  const nullRequestId = decodeJsonRpcMessage({
    jsonrpc: '2.0',
    id: null,
    method: 'multiply',
  });
  assert.equal(nullRequestId.ok, false);

  // 防御 getter：decodeJsonValue 不应执行对象上的任何 getter（等价于任意代码执行）。
  let getterCalls = 0;
  const hostile = { jsonrpc: '2.0', id: 1, method: 'multiply' };
  Object.defineProperty(hostile, 'params', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return {};
    },
  });
  const getter = decodeJsonRpcMessage(hostile);
  assert.equal(getter.ok, false);
  // 关键断言：getter 调用次数必须是 0，证明协议层不会执行 wire 对象上的代码。
  assert.equal(getterCalls, 0);

  // 1e400 不是有限数字（Infinity）：JSON.parse 会接受但协议层拒绝。
  assert.throws(
    () => parseJsonRpcText('{"jsonrpc":"2.0","id":1,"result":1e400}'),
    /有限数字/u,
  );
});

// 第 2 组：stdio framing——任意字节边界都能恢复完整消息，并拒绝空行/残帧。
test('stdio decoder 在任意 UTF-8 chunk 边界恢复单行消息，并拒绝空行与残帧', () => {
  // 构造一条含中文 + 内嵌换行的消息：内嵌换行会被 JSON.stringify 转义，只有 delimiter 是真实 LF。
  const message: JsonRpcMessage = {
    jsonrpc: '2.0',
    id: '请求-1',
    method: 'search',
    params: { query: '你好\nTypeScript' },
  };
  const bytes = encodeForStdio(message);
  const decoder = new StdioJsonRpcDecoder();
  const decoded: JsonRpcMessage[] = [];
  // 一次只喂一个 byte，必然把中文字符拆到多个 chunk。
  // 这能验证 TextDecoder 的 stream:true 与 #drainLines 的跨 chunk 缓冲正确性。
  for (const byte of bytes) decoded.push(...decoder.push(Uint8Array.of(byte)));
  decoded.push(...decoder.finish());
  assert.deepEqual(decoded, [message]);
  // encodeJsonRpcLine 只在末尾留一个真实 LF，所以 split('\n') 得到 [body, '']，长度 2。
  assert.equal(encodeJsonRpcLine(message).split('\n').length, 2);

  // 空行（仅 '\n'）必须被拒绝：JSON-RPC stdio 不允许心跳/分隔用的空行。
  const blank = new StdioJsonRpcDecoder();
  assert.throws(() => blank.push(new TextEncoder().encode('\n')), /空消息行/u);

  // 流结束时仍有未完成消息（无 LF）必须报错，避免静默丢消息。
  const partial = new StdioJsonRpcDecoder();
  partial.push(new TextEncoder().encode('{"jsonrpc":"2.0"}'));
  assert.throws(() => partial.finish(), /缺少换行/u);
});

// 第 3 组：关联器核心——response 按到达顺序无关地用 id 配对。
test('client 用 id 关联乱序 response，而不是依赖到达顺序', async () => {
  const transport = new ManualTransport();
  const client = new JsonRpcClient(transport, calculatorMethods);
  // 连发两个 request：id 自增成 1、2。
  const first = client.request('multiply', { left: 2, right: 3 });
  const second = client.request('multiply', { left: 4, right: 5 });

  // 验证 wire 上的 id 顺序确实是 [1, 2]。
  assert.deepEqual(
    transport.sent.map((message) => 'id' in message ? message.id : undefined),
    [1, 2],
  );
  // 故意先注入 id=2 的 response（乱序），client 应仍能正确配对。
  transport.inject({ jsonrpc: '2.0', id: 2, result: { value: 20 } });
  transport.inject({ jsonrpc: '2.0', id: 1, result: { value: 6 } });

  // 每个 Promise 拿到的是与自己 id 对应的结果，与到达顺序无关。
  assert.deepEqual(await first, { value: 6 });
  assert.deepEqual(await second, { value: 20 });
  assert.equal(client.pendingCount, 0);
});

// 第 4 组：协议级错误——未知 id 与重复 response 都视为连接故障。
test('未知 response id 与重复 response 是连接级协议错误', async () => {
  // 未知 id：client 从没发过这个 request，response 必然是幽灵 → 关闭连接。
  const unknownTransport = new ManualTransport();
  const unknownClient = new JsonRpcClient(unknownTransport, calculatorMethods);
  unknownTransport.inject({ jsonrpc: '2.0', id: 999, result: { value: 1 } });
  assert.equal(unknownClient.closed, true);
  assert.ok(unknownTransport.closeReason instanceof RpcProtocolViolationError);

  // 重复 response：同一个 id 收到两次 → 第二次必然是协议违规。
  const duplicateTransport = new ManualTransport();
  const duplicateClient = new JsonRpcClient(duplicateTransport, calculatorMethods);
  const request = duplicateClient.request('multiply', { left: 2, right: 2 });
  const response = { jsonrpc: '2.0', id: 1, result: { value: 4 } } as const;
  duplicateTransport.inject(response);
  assert.deepEqual(await request, { value: 4 });
  duplicateTransport.inject(response);
  assert.equal(duplicateClient.closed, true);
  assert.ok(duplicateTransport.closeReason instanceof RpcProtocolViolationError);
});

// 第 5 组：取消——删 pending、发 notification、忽略竞态迟到 response。
test('取消删除 pending、发送 notification，并忽略竞态迟到 response', async () => {
  const transport = new ManualTransport();
  const client = new JsonRpcClient(transport, calculatorMethods);
  const controller = new AbortController();
  const request = client.request(
    'multiply',
    { left: 2, right: 3 },
    { signal: controller.signal },
  );
  // abort 触发 cancel 路径。
  controller.abort('user cancelled');

  // 调用方拿到 RpcRequestCancelledError。
  await assert.rejects(request, RpcRequestCancelledError);
  assert.equal(client.pendingCount, 0);
  // wire 上依次出现：原 request + notifications/cancelled 通知。
  assert.deepEqual(transport.sent.map((message) => {
    return 'method' in message ? message.method : 'response';
  }), ['multiply', 'notifications/cancelled']);

  // 取消之后 server 才回包（竞态）：墓碑机制让这条迟到 response 被静默忽略，不升级为协议错误。
  transport.inject({ jsonrpc: '2.0', id: 1, result: { value: 6 } });
  assert.equal(client.closed, false);
});

// 第 6 组：notification 出口也走 JSON 安全化，不依赖调用方的类型声明。
test('notification 发送边界也验证 JSON 对象图，不依赖调用方类型声明', async () => {
  const transport = new ManualTransport();
  const client = new JsonRpcClient(transport, calculatorMethods);
  // 故意构造一个带 getter 的对象：如果协议层直接 JSON.stringify 会执行 getter。
  let getterCalls = 0;
  const params: Record<string, string> = {};
  Object.defineProperty(params, 'secret', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'should not run';
    },
  });

  await assert.rejects(
    client.notify('notifications/example', params),
    RpcPayloadValidationError,
  );
  // getter 没被执行；消息也没被发出去。
  assert.equal(getterCalls, 0);
  assert.equal(transport.sent.length, 0);
});

// 第 7 组：transport 关闭会清理全部 pending，调用方统一拿到 RpcConnectionClosedError。
test('transport 关闭会拒绝并清空全部 pending request', async () => {
  const transport = new ManualTransport();
  const client = new JsonRpcClient(transport, calculatorMethods);
  const request = client.request('multiply', { left: 2, right: 3 });
  transport.remoteClose('socket reset');

  await assert.rejects(request, RpcConnectionClosedError);
  assert.equal(client.pendingCount, 0);
  assert.equal(client.closed, true);
});

// 第 8 组：wire 证据——response 必须再过一遍 method 的 result schema。
// 静态类型（result.value: number）不能替代运行时校验，因为 wire 值可能撒谎。
test('response 必须再次通过 method result schema，静态泛型不能替代 wire 证据', async () => {
  const transport = new ManualTransport();
  const client = new JsonRpcClient(transport, calculatorMethods);
  const request = client.request('multiply', { left: 2, right: 3 });
  // server 回的 value 是字符串 'six'，与 schema 不符。
  transport.inject({ jsonrpc: '2.0', id: 1, result: { value: 'six' } });

  await assert.rejects(request, RpcPayloadValidationError);
  // 这种 payload 错误不是协议错误：连接保持打开，pending 表也清空。
  assert.equal(client.closed, false);
  assert.equal(client.pendingCount, 0);
});

// 第 9 组：MCP 完整生命周期——握手、能力协商、工具调用、错误归一化。
test('MCP session 强制 initialize → initialized → operational，并协商 tools capability', async () => {
  // 两个工具：一个正常返回，一个故意抛内部错误（验证脱敏）。
  const sumTool = defineMcpTool({
    name: 'sum',
    description: 'sum values',
    inputSchema: object({ left: number(), right: number() }),
    async execute(input) {
      return String(input.left + input.right);
    },
  });
  const failingTool = defineMcpTool({
    name: 'always_fail',
    description: 'failure classification',
    inputSchema: object({}),
    async execute() {
      // 内部错误细节，不应泄露到 wire。
      throw new Error('secret database detail');
    },
  });
  const pair = createMemoryTransportPair();
  const server = new McpServerSession(
    pair.server,
    [sumTool, failingTool] as const,
    { name: 'test-server', version: '1.0.0' },
  );
  const client = new McpClientSession(pair.client);

  // 握手前调 listTools 应被 client 状态机拒绝。
  assert.throws(() => client.listTools(), McpLifecycleError);
  await client.ping();
  await client.initialize({ clientName: 'test-client', clientVersion: '1.0.0' });
  assert.equal(client.state, 'operational');
  assert.equal(server.state, 'operational');

  // tools/list 顺序保留注册顺序。
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), ['sum', 'always_fail']);
  // 正常工具调用。
  const result = await client.callTool({
    name: 'sum',
    arguments: { left: 7, right: 8 },
  });
  assert.equal(result.content[0]?.text, '15');
  assert.equal(result.isError, false);

  // 抛错工具：MCP 把工具错误归一化成 isError:true 的正常响应，不泄露 cause。
  const failure = await client.callTool({ name: 'always_fail', arguments: {} });
  assert.equal(failure.isError, true);
  assert.doesNotMatch(failure.content[0]?.text ?? '', /database/u);

  // 未知工具：升级为 RPC error（-32602），client 拿到 RpcRemoteError。
  await assert.rejects(
    client.callTool({ name: 'missing', arguments: {} }),
    (cause: unknown) => cause instanceof RpcRemoteError
      && cause.rpcError.code === -32602,
  );
  // initialize 只能调一次：再次调用应被生命周期状态机拒绝。
  await assert.rejects(
    client.initialize({ clientName: 'again', clientVersion: '1.0.0' }),
    McpLifecycleError,
  );
  await client.close();
});

// 第 10 组：server 侧自己的门禁——不能只依赖 client 不发错请求。
test('server 自己也拒绝 initialization 前的能力请求，不能只依赖 client 门禁', async () => {
  const pair = createMemoryTransportPair();
  const server = new McpServerSession(
    pair.server,
    [] as const,
    { name: 'guard-server', version: '1.0.0' },
  );
  // 用原始 JsonRpcClient 绕过 McpClientSession，模拟恶意/裸 client 直接发 tools/list。
  const rawClient = new JsonRpcClient(pair.client, mcpMethodSchemas);

  await assert.rejects(
    rawClient.request('tools/list', {}),
    (cause: unknown) => cause instanceof RpcRemoteError
      && cause.rpcError.code === -32002,
  );
  // server 仍处于 idle（错误响应不应改变状态）。
  assert.equal(server.state, 'idle');
  await rawClient.close();
});

// 第 11 组：版本协商失败时不能误发 initialized 通知。
test('initialize 版本不兼容时断开，且不会错误发送 initialized notification', async () => {
  const transport = new ManualTransport();
  const client = new McpClientSession(transport);
  // client 只支持旧版本，server 回新版本 → 不匹配。
  const initialization = client.initialize({
    clientName: 'old-client',
    clientVersion: '1.0.0',
    supportedVersions: ['2024-11-05'],
  });
  // 第一条发出的是 initialize（不是其它）。
  assert.equal(
    'method' in transport.sent[0]! && transport.sent[0]!.method,
    'initialize',
  );
  transport.inject({
    jsonrpc: '2.0',
    id: 1,
    result: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'new-server', version: '1.0.0' },
    },
  });

  // 版本不匹配 → 抛 McpLifecycleError；session 进入 closed。
  await assert.rejects(initialization, McpLifecycleError);
  assert.equal(client.state, 'closed');
  // 关键断言：wire 上只有 initialize，没有 notifications/initialized（握手未完成不应发）。
  assert.deepEqual(
    transport.sent
      .filter((message) => 'method' in message)
      .map((message) => message.method),
    ['initialize'],
  );
});

// 第 12 组：取消信号穿越 RPC 层直达工具执行体，且被取消的请求不再回 response。
test('MCP cancellation 传播到 server tool，server 不再发送已取消请求的 response', async () => {
  // 用两个 deferred 协调时序：entered 等工具进入执行体，aborted 等工具感知到 abort。
  const entered = deferred<void>();
  const aborted = deferred<void>();
  const slowTool = defineMcpTool({
    name: 'slow',
    description: 'wait for cancellation',
    inputSchema: object({ value: string() }),
    async execute(_input, context): Promise<string> {
      entered.resolve(undefined);
      // 永远挂起，直到 signal abort 触发 reject。
      await new Promise<never>((_resolve, reject) => {
        const onAbort = () => {
          aborted.resolve(undefined);
          reject(context.signal.reason);
        };
        context.signal.addEventListener('abort', onAbort, { once: true });
      });
      return 'unreachable';
    },
  });
  const pair = createMemoryTransportPair();
  const server = new McpServerSession(
    pair.server,
    [slowTool] as const,
    { name: 'cancel-server', version: '1.0.0' },
  );
  const client = new McpClientSession(pair.client);
  await client.initialize({ clientName: 'cancel-client', clientVersion: '1.0.0' });

  const controller = new AbortController();
  const call = client.callTool(
    { name: 'slow', arguments: { value: 'x' } },
    { signal: controller.signal },
  );
  // 等工具进入执行体后才 abort，确保取消信号有真实目标。
  await entered.promise;
  controller.abort('stop slow tool');

  // client 侧拿到 RpcRequestCancelledError。
  await assert.rejects(call, RpcRequestCancelledError);
  // server 侧 tool 感知到 abort。
  await aborted.promise;
  // 让 finally 清理 continuation 跑完。
  await Promise.resolve();
  assert.equal(server.inFlightCount, 0);
  // 取消是单次请求级故障，不应拖垮整条连接。
  assert.equal(client.state, 'operational');
  await client.close();
});

// 第 13 组：动态装配边界 fail-fast——工具名非法、注册时重名都立刻报错。
test('MCP tool name 与 registry 重名在动态装配边界 fail-fast', () => {
  // 非法 tool name（含空格）：defineMcpTool 立刻拒绝。
  assert.throws(
    () => defineMcpTool({
      name: 'contains space',
      description: 'invalid',
      inputSchema: object({}),
      async execute() {
        return 'never';
      },
    }),
    /tool name/u,
  );

  // 合法定义但重复注册：McpToolRegistry 构造时检测到重名立即抛错。
  const duplicate = defineMcpTool({
    name: 'duplicate',
    description: 'duplicate',
    inputSchema: object({}),
    async execute() {
      return 'ok';
    },
  });
  const pair = createMemoryTransportPair();
  assert.throws(
    () => new McpServerSession(
      pair.server,
      [duplicate, duplicate] as const,
      { name: 'server', version: '1.0.0' },
    ),
    /重名/u,
  );
});

// ManualTransport：测试专用的 RpcTransport 双工实现。
// - send 暂存到 sent 数组（用 structuredClone 防止调用方后续修改影响断言）；
// - inject 模拟远端发来一条原始消息；
// - remoteClose 模拟远端单方面断连。
class ManualTransport implements RpcTransport {
  readonly sent: JsonRpcMessage[] = [];
  readonly #messageListeners = new Set<(raw: unknown) => void>();
  readonly #closeListeners = new Set<(reason: unknown) => void>();
  closeReason: unknown;

  async send(message: JsonRpcMessage): Promise<void> {
    this.sent.push(structuredClone(message));
  }

  onMessage(listener: (raw: unknown) => void): Unsubscribe {
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }

  onClose(listener: (reason: unknown) => void): Unsubscribe {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  async close(reason?: unknown): Promise<void> {
    this.closeReason = reason;
    for (const listener of [...this.#closeListeners]) listener(reason);
  }

  inject(raw: unknown): void {
    for (const listener of [...this.#messageListeners]) listener(raw);
  }

  remoteClose(reason: unknown): void {
    for (const listener of [...this.#closeListeners]) listener(reason);
  }
}

// Deferred：测试用的“外部可控 Promise”。resolve 暴露给调用方，用于跨 await 协调时序。
type Deferred<Value> = {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
};

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

// 运行时测试无法证明 method → params/result 的泛型相关性；负向类型测试补上另一条证据链。
// 这个函数永远不会真的执行（被 if (false) 包裹），它的存在仅为让 tsc 检查下面的类型断言。
async function verifyStaticMethodContracts(
  client: JsonRpcClient<typeof calculatorMethods>,
): Promise<void> {
  const result = await client.request('multiply', { left: 2, right: 3 });
  const value: number = result.value;
  void value;

  // @ts-expect-error multiply.params 缺少 right
  await client.request('multiply', { left: 2 });

  // @ts-expect-error result.value 是 number，不是 string
  const wrong: string = result.value;
  void wrong;
}

if (false) {
  void verifyStaticMethodContracts(
    new JsonRpcClient(new ManualTransport(), calculatorMethods),
  );
}
