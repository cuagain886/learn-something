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

const calculatorMethods = {
  multiply: {
    params: object({ left: number(), right: number() }),
    result: object({ value: number() }),
  },
} as const;

test('wire decoder 强制 request/notification/response 互斥，并且不执行 getter', () => {
  const request = decodeJsonRpcMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'multiply',
    params: { left: 2, right: 3 },
  });
  assert.equal(request.ok, true);

  const both = decodeJsonRpcMessage({
    jsonrpc: '2.0',
    id: 1,
    result: 6,
    error: { code: -32603, message: 'impossible' },
  });
  assert.equal(both.ok, false);
  if (!both.ok) assert.match(both.issues[0]?.message ?? '', /只能包含/u);

  const nullRequestId = decodeJsonRpcMessage({
    jsonrpc: '2.0',
    id: null,
    method: 'multiply',
  });
  assert.equal(nullRequestId.ok, false);

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
  assert.equal(getterCalls, 0);

  assert.throws(
    () => parseJsonRpcText('{"jsonrpc":"2.0","id":1,"result":1e400}'),
    /有限数字/u,
  );
});

test('stdio decoder 在任意 UTF-8 chunk 边界恢复单行消息，并拒绝空行与残帧', () => {
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
  for (const byte of bytes) decoded.push(...decoder.push(Uint8Array.of(byte)));
  decoded.push(...decoder.finish());
  assert.deepEqual(decoded, [message]);
  assert.equal(encodeJsonRpcLine(message).split('\n').length, 2);

  const blank = new StdioJsonRpcDecoder();
  assert.throws(() => blank.push(new TextEncoder().encode('\n')), /空消息行/u);

  const partial = new StdioJsonRpcDecoder();
  partial.push(new TextEncoder().encode('{"jsonrpc":"2.0"}'));
  assert.throws(() => partial.finish(), /缺少换行/u);
});

test('client 用 id 关联乱序 response，而不是依赖到达顺序', async () => {
  const transport = new ManualTransport();
  const client = new JsonRpcClient(transport, calculatorMethods);
  const first = client.request('multiply', { left: 2, right: 3 });
  const second = client.request('multiply', { left: 4, right: 5 });

  assert.deepEqual(
    transport.sent.map((message) => 'id' in message ? message.id : undefined),
    [1, 2],
  );
  transport.inject({ jsonrpc: '2.0', id: 2, result: { value: 20 } });
  transport.inject({ jsonrpc: '2.0', id: 1, result: { value: 6 } });

  assert.deepEqual(await first, { value: 6 });
  assert.deepEqual(await second, { value: 20 });
  assert.equal(client.pendingCount, 0);
});

test('未知 response id 与重复 response 是连接级协议错误', async () => {
  const unknownTransport = new ManualTransport();
  const unknownClient = new JsonRpcClient(unknownTransport, calculatorMethods);
  unknownTransport.inject({ jsonrpc: '2.0', id: 999, result: { value: 1 } });
  assert.equal(unknownClient.closed, true);
  assert.ok(unknownTransport.closeReason instanceof RpcProtocolViolationError);

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

test('取消删除 pending、发送 notification，并忽略竞态迟到 response', async () => {
  const transport = new ManualTransport();
  const client = new JsonRpcClient(transport, calculatorMethods);
  const controller = new AbortController();
  const request = client.request(
    'multiply',
    { left: 2, right: 3 },
    { signal: controller.signal },
  );
  controller.abort('user cancelled');

  await assert.rejects(request, RpcRequestCancelledError);
  assert.equal(client.pendingCount, 0);
  assert.deepEqual(transport.sent.map((message) => {
    return 'method' in message ? message.method : 'response';
  }), ['multiply', 'notifications/cancelled']);

  transport.inject({ jsonrpc: '2.0', id: 1, result: { value: 6 } });
  assert.equal(client.closed, false);
});

test('notification 发送边界也验证 JSON 对象图，不依赖调用方类型声明', async () => {
  const transport = new ManualTransport();
  const client = new JsonRpcClient(transport, calculatorMethods);
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
  assert.equal(getterCalls, 0);
  assert.equal(transport.sent.length, 0);
});

test('transport 关闭会拒绝并清空全部 pending request', async () => {
  const transport = new ManualTransport();
  const client = new JsonRpcClient(transport, calculatorMethods);
  const request = client.request('multiply', { left: 2, right: 3 });
  transport.remoteClose('socket reset');

  await assert.rejects(request, RpcConnectionClosedError);
  assert.equal(client.pendingCount, 0);
  assert.equal(client.closed, true);
});

test('response 必须再次通过 method result schema，静态泛型不能替代 wire 证据', async () => {
  const transport = new ManualTransport();
  const client = new JsonRpcClient(transport, calculatorMethods);
  const request = client.request('multiply', { left: 2, right: 3 });
  transport.inject({ jsonrpc: '2.0', id: 1, result: { value: 'six' } });

  await assert.rejects(request, RpcPayloadValidationError);
  assert.equal(client.closed, false);
  assert.equal(client.pendingCount, 0);
});

test('MCP session 强制 initialize → initialized → operational，并协商 tools capability', async () => {
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

  assert.throws(() => client.listTools(), McpLifecycleError);
  await client.ping();
  await client.initialize({ clientName: 'test-client', clientVersion: '1.0.0' });
  assert.equal(client.state, 'operational');
  assert.equal(server.state, 'operational');

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), ['sum', 'always_fail']);
  const result = await client.callTool({
    name: 'sum',
    arguments: { left: 7, right: 8 },
  });
  assert.equal(result.content[0]?.text, '15');
  assert.equal(result.isError, false);

  const failure = await client.callTool({ name: 'always_fail', arguments: {} });
  assert.equal(failure.isError, true);
  assert.doesNotMatch(failure.content[0]?.text ?? '', /database/u);

  await assert.rejects(
    client.callTool({ name: 'missing', arguments: {} }),
    (cause: unknown) => cause instanceof RpcRemoteError
      && cause.rpcError.code === -32602,
  );
  await assert.rejects(
    client.initialize({ clientName: 'again', clientVersion: '1.0.0' }),
    McpLifecycleError,
  );
  await client.close();
});

test('server 自己也拒绝 initialization 前的能力请求，不能只依赖 client 门禁', async () => {
  const pair = createMemoryTransportPair();
  const server = new McpServerSession(
    pair.server,
    [] as const,
    { name: 'guard-server', version: '1.0.0' },
  );
  const rawClient = new JsonRpcClient(pair.client, mcpMethodSchemas);

  await assert.rejects(
    rawClient.request('tools/list', {}),
    (cause: unknown) => cause instanceof RpcRemoteError
      && cause.rpcError.code === -32002,
  );
  assert.equal(server.state, 'idle');
  await rawClient.close();
});

test('initialize 版本不兼容时断开，且不会错误发送 initialized notification', async () => {
  const transport = new ManualTransport();
  const client = new McpClientSession(transport);
  const initialization = client.initialize({
    clientName: 'old-client',
    clientVersion: '1.0.0',
    supportedVersions: ['2024-11-05'],
  });
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

  await assert.rejects(initialization, McpLifecycleError);
  assert.equal(client.state, 'closed');
  assert.deepEqual(
    transport.sent
      .filter((message) => 'method' in message)
      .map((message) => message.method),
    ['initialize'],
  );
});

test('MCP cancellation 传播到 server tool，server 不再发送已取消请求的 response', async () => {
  const entered = deferred<void>();
  const aborted = deferred<void>();
  const slowTool = defineMcpTool({
    name: 'slow',
    description: 'wait for cancellation',
    inputSchema: object({ value: string() }),
    async execute(_input, context): Promise<string> {
      entered.resolve(undefined);
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
  await entered.promise;
  controller.abort('stop slow tool');

  await assert.rejects(call, RpcRequestCancelledError);
  await aborted.promise;
  await Promise.resolve();
  assert.equal(server.inFlightCount, 0);
  assert.equal(client.state, 'operational');
  await client.close();
});

test('MCP tool name 与 registry 重名在动态装配边界 fail-fast', () => {
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
