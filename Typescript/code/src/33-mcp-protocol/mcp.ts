// mcp.ts：MCP 协议方法表 + 客户端/服务端 Session（生命周期状态机）。
//
// 分层定位：
//   - 定义教学子集的 method schemas（initialize / ping / tools/list / tools/call）；
//   - McpClientSession 包装 JsonRpcClient，加上 idle→initializing→operational→closed 状态机；
//   - McpServerSession 包装 JsonRpcServer，加上镜像的生命周期 + 工具注册表；
//   - 把 client.ts / server.ts 的“原始 RPC 能力”收敛成 MCP 语义。
import {
  array,
  boolean,
  literal,
  object,
  optional,
  string,
  toJsonPointer,
  type JsonSchema,
  type Schema,
  type ValidationIssue,
} from '../17-schema.js';
import { JsonRpcClient } from './client.js';
import type { AnyRpcMethodSchema } from './codec.js';
import {
  decodeJsonValue,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type RequestId,
} from './jsonrpc.js';
import {
  JsonRpcServer,
  RpcApplicationError,
} from './server.js';
import type { RpcTransport } from './transport.js';

/** 文档核对日期 2026-07-19；官方 latest 当前指向此 revision。 */
export const MCP_PROTOCOL_VERSION = '2025-11-25';

// jsonObjectSchema：构造一个“接受任意 JSON object”的 Schema。
// 用于 capabilities / tool arguments 等结构开放的位置——具体字段由上层语义决定。
// 内部复用 jsonrpc.ts 的 decodeJsonValue 做 JSON 安全化，再断言是 object。
function jsonObjectSchema(description: string): Schema<JsonObject> {
  const jsonSchema: JsonSchema = {
    type: 'object',
    additionalProperties: true,
    description,
  };
  return {
    jsonSchema,
    safeParse(input, path = []) {
      const decoded = decodeJsonValue(input);
      if (!decoded.ok) {
        // 把协议层 ProtocolIssue 翻译成 17-schema 的 ValidationIssue，统一错误模型。
        const issues: ValidationIssue[] = decoded.issues.map((item) => ({
          code: 'not_json_value',
          path: [...path, ...item.path],
          pointer: toJsonPointer([...path, ...item.path]),
          message: item.message,
          received: 'non-JSON value',
        }));
        return { ok: false, error: issues };
      }
      if (!isJsonObject(decoded.value)) {
        return {
          ok: false,
          error: [{
            code: 'invalid_type',
            path,
            pointer: toJsonPointer(path),
            message: '期望 JSON object',
            expected: 'object',
            received: Array.isArray(decoded.value) ? 'array' : typeof decoded.value,
          }],
        };
      }
      return { ok: true, value: decoded.value };
    },
  };
}

// capabilitiesSchema：MCP capability bag——结构开放（不同 server 宣告不同能力）。
const capabilitiesSchema = jsonObjectSchema('协商后的 MCP capability bag');
// implementationSchema：client/server 的实现信息（name/version 必填，title/description/websiteUrl 可选）。
// unknownKeys: 'strip' 让 wire 上多出的字段被静默丢弃，而不是报错。
const implementationSchema = object({
  name: string({ minLength: 1 }),
  version: string({ minLength: 1 }),
  title: optional(string({ minLength: 1 })),
  description: optional(string({ minLength: 1 })),
  websiteUrl: optional(string({ minLength: 1 })),
}, { unknownKeys: 'strip' });

// initializeParamsSchema：client 发起的 initialize 请求参数。
const initializeParamsSchema = object({
  protocolVersion: string({ minLength: 1 }),
  capabilities: capabilitiesSchema,
  clientInfo: implementationSchema,
});

// initializeResultSchema：server 的 initialize 响应。
const initializeResultSchema = object({
  protocolVersion: string({ minLength: 1 }),
  capabilities: capabilitiesSchema,
  serverInfo: implementationSchema,
  instructions: optional(string()),
});

// 下面是 tools/* 相关的 schemas：
const emptyObjectSchema = object({});
// toolNameSchema：MCP 工具命名规则——1..128 个 [A-Za-z0-9_.-] 字符。
const toolNameSchema = string({
  minLength: 1,
  pattern: /^[A-Za-z0-9_.-]{1,128}$/,
});
// toolDescriptorSchema：tools/list 返回的单个工具描述（name + 可选 title/description + inputSchema JSON Schema）。
const toolDescriptorSchema = object({
  name: toolNameSchema,
  title: optional(string({ minLength: 1 })),
  description: optional(string()),
  inputSchema: jsonObjectSchema('工具参数 JSON Schema'),
}, { unknownKeys: 'strip' });
const listToolsParamsSchema = object({
  cursor: optional(string({ minLength: 1 })),
});
const listToolsResultSchema = object({
  tools: array(toolDescriptorSchema),
  nextCursor: optional(string({ minLength: 1 })),
});
const callToolParamsSchema = object({
  name: toolNameSchema,
  arguments: optional(jsonObjectSchema('工具 arguments')),
});
// textContentSchema：教学子集只支持 text 内容类型（完整 MCP 还支持 image/audio/resource 等）。
const textContentSchema = object({
  type: literal('text'),
  text: string(),
});
const callToolResultSchema = object({
  content: array(textContentSchema, { minItems: 1 }),
  isError: optional(boolean()),
});

/**
 * 教学子集：覆盖 MCP 生命周期、ping、tools/list 与 text-only tools/call。
 * 完整 MCP 还包含 resources/prompts/sampling/elicitation/tasks 等能力。
 */
// mcpMethodSchemas：把上面所有 schema 装配成 method table。
// satisfies Record<string, AnyRpcMethodSchema> 保证每个 entry 都是合法的 RpcMethodSchema，
// 同时保留字面量 key（让 client.request('initialize', ...) 的 name 参数有精确类型）。
export const mcpMethodSchemas = {
  initialize: {
    params: initializeParamsSchema,
    result: initializeResultSchema,
  },
  ping: {
    params: emptyObjectSchema,
    result: emptyObjectSchema,
  },
  'tools/list': {
    params: listToolsParamsSchema,
    result: listToolsResultSchema,
  },
  'tools/call': {
    params: callToolParamsSchema,
    result: callToolResultSchema,
  },
} as const satisfies Record<string, AnyRpcMethodSchema>;

// McpClientState：客户端生命周期状态机。
// idle → initializing（发 initialize）→ operational（收到 result + 发 initialized）→ closed。
export type McpClientState =
  | 'idle'
  | 'initializing'
  | 'operational'
  | 'closed';

// McpLifecycleError：生命周期违规（如 operational 状态再调 initialize）。
export class McpLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpLifecycleError';
  }
}

// McpClientSession：在 JsonRpcClient 之上加 MCP 生命周期与 capability 协商。
export class McpClientSession {
  // 内部的 RPC 关联器；methods 直接用上面的 mcpMethodSchemas。
  readonly #rpc: JsonRpcClient<typeof mcpMethodSchemas>;
  #state: McpClientState = 'idle';
  // #serverCapabilities：initialize 成功后缓存，listTools/callTool 用它做 capability 门禁。
  #serverCapabilities: JsonObject | undefined;

  constructor(transport: RpcTransport) {
    this.#rpc = new JsonRpcClient(transport, mcpMethodSchemas);
  }

  // state：对外暴露的当前状态。RPC 已关闭时统一报 'closed'。
  get state(): McpClientState {
    return this.#rpc.closed ? 'closed' : this.#state;
  }

  get pendingCount(): number {
    return this.#rpc.pendingCount;
  }

  /** ping 是规范明确允许在 initialization 完成前调用的少数请求。 */
  ping(options?: { readonly timeoutMs?: number }) {
    this.#ensureNotClosed();
    return this.#rpc.request('ping', {}, options);
  }

  // initialize：发起 MCP 握手。
  // 协议要点：
  //   - 只能从 idle 调一次；
  //   - 支持多版本偏好（supportedVersions），client 发第一项，server 可任选其一；
  //   - initialize 禁止发送 cancellation（sendCancellation: false），超时直接关闭整条连接；
  //   - 成功后必须发 notifications/initialized 通知 server 进入 operational。
  async initialize(options: {
    readonly clientName: string;
    readonly clientVersion: string;
    /** 按偏好从高到低排列；请求发送第一项，响应可选择其中任意一项。 */
    readonly supportedVersions?: readonly string[];
    readonly requireToolsCapability?: boolean;
    readonly timeoutMs?: number;
  }): Promise<void> {
    if (this.#state !== 'idle') {
      throw new McpLifecycleError(`initialize 只能从 idle 调用，当前为 ${this.#state}`);
    }
    this.#state = 'initializing';
    const supportedVersions = options.supportedVersions ?? [MCP_PROTOCOL_VERSION];
    const requestedVersion = supportedVersions[0];
    if (requestedVersion === undefined) {
      // 没有可发版本：回滚到 idle（连接尚未使用）。
      this.#state = 'idle';
      throw new RangeError('supportedVersions 至少包含一个版本');
    }
    const supported = new Set(supportedVersions);
    try {
      // MCP 禁止发送 initialize cancellation：超时会停止等待并关闭整条连接，而不发取消通知。
      const result = await this.#rpc.request(
        'initialize',
        {
          protocolVersion: requestedVersion,
          capabilities: {},
          clientInfo: {
            name: options.clientName,
            version: options.clientVersion,
          },
        },
        {
          timeoutMs: options.timeoutMs ?? 10_000,
          sendCancellation: false,
        },
      );
      // server 选了 client 不支持的版本：视为不可用，关闭连接。
      if (!supported.has(result.protocolVersion)) {
        throw new McpLifecycleError(
          `server 选择了不支持的 protocolVersion ${result.protocolVersion}`,
        );
      }
      // capability 门禁：教学实现要求 server 必须宣告 tools 能力（可关掉）。
      if (
        options.requireToolsCapability !== false
        && !isCapabilityObject(result.capabilities['tools'])
      ) {
        throw new McpLifecycleError('server 没有协商 tools capability');
      }
      this.#serverCapabilities = result.capabilities;
      // 握手最后一步：通知 server 已初始化，双方都进入 operational。
      await this.#rpc.notify('notifications/initialized');
      this.#state = 'operational';
    } catch (cause: unknown) {
      // 握手任意一步失败：进入 closed，关闭 RPC，把原错误抛给调用方。
      this.#state = 'closed';
      await this.#rpc.close(cause);
      throw cause;
    }
  }

  // listTools：列出 server 工具。必须在 operational 且协商过 tools capability。
  listTools(
    params: { readonly cursor?: string } = {},
    options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
  ) {
    this.#ensureOperational('tools/list', 'tools');
    return this.#rpc.request('tools/list', params, options);
  }

  // callTool：调用一个工具。arguments 是开放结构（按工具 inputSchema 校验）。
  callTool(
    params: { readonly name: string; readonly arguments?: JsonObject },
    options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
  ) {
    this.#ensureOperational('tools/call', 'tools');
    return this.#rpc.request('tools/call', params, options);
  }

  // close：主动关闭 session。
  async close(reason: unknown = new Error('MCP client 主动关闭')): Promise<void> {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    await this.#rpc.close(reason);
  }

  // #ensureOperational：能力请求的双重门禁——状态必须是 operational，且协商过对应 capability。
  // 注意：这只在 client 侧拦截；server 侧也有自己的门禁（防止恶意 client 绕过本端检查）。
  #ensureOperational(method: string, capability: string): void {
    if (this.state !== 'operational') {
      throw new McpLifecycleError(`${method} 只能在 operational 状态调用`);
    }
    if (!isCapabilityObject(this.#serverCapabilities?.[capability])) {
      throw new McpLifecycleError(`未协商 ${capability} capability`);
    }
  }

  #ensureNotClosed(): void {
    if (this.state === 'closed') throw new McpLifecycleError('MCP session 已关闭');
  }
}

// McpToolContext：传给 tool execute 的上下文。
// signal 来自 server 的 inFlight controller——client 取消时 tool 能感知。
export type McpToolContext = {
  readonly requestId: RequestId;
  readonly signal: AbortSignal;
};

// McpToolDefinition：一个工具的完整定义。
// __input 是 phantom 字段，仅用于让 Infer 能从定义里抽出 Input 类型，运行时不占空间。
export interface McpToolDefinition<Name extends string, Input> {
  readonly name: Name;
  readonly description: string;
  readonly inputSchema: Schema<Input>;
  execute(input: Input, context: McpToolContext): string | Promise<string>;
  readonly __input?: Input;
}

// AnyMcpTool：工具定义的类型擦除版本，用于 registry 存储与遍历。
export type AnyMcpTool = McpToolDefinition<string, unknown>;

// defineMcpTool：工具定义工厂。
// const 类型参数保留 name 字面量；构造时 fail-fast 校验 name 命名规则。
export function defineMcpTool<const Name extends string, Input>(definition: {
  readonly name: Name;
  readonly description: string;
  readonly inputSchema: Schema<Input>;
  readonly execute: (
    input: Input,
    context: McpToolContext,
  ) => string | Promise<string>;
}): McpToolDefinition<Name, Input> {
  if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(definition.name)) {
    throw new RangeError('MCP tool name 必须是 1..128 个 ASCII 字母/数字/_.-');
  }
  return definition;
}

// McpToolRegistry：服务端工具注册表。
// 负责：(1) 构造时校验重名；(2) 输出 wire 描述符；(3) 执行工具并归一化结果/错误。
class McpToolRegistry<Tools extends readonly AnyMcpTool[]> {
  readonly #tools = new Map<string, AnyMcpTool>();

  constructor(tools: Tools) {
    for (const tool of tools) {
      // 重名 fail-fast：在装配点暴露问题，而不是等到运行时 callTool 才发现。
      if (this.#tools.has(tool.name)) throw new Error(`MCP tool 重名: ${tool.name}`);
      this.#tools.set(tool.name, tool);
    }
  }

  // descriptors：生成 tools/list 的返回结构。
  // 把每个工具的 inputSchema.jsonSchema 走一遍 JSON 安全化——确保输出是可发送的 wire object。
  descriptors() {
    return [...this.#tools.values()].map((tool) => {
      const decoded = decodeJsonValue(tool.inputSchema.jsonSchema);
      if (
        !decoded.ok
        || !isJsonObject(decoded.value)
      ) {
        throw new Error(`工具 ${tool.name} 的 inputSchema 不是 JSON object`);
      }
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: decoded.value,
      };
    });
  }

  // call：执行一个工具调用。
  // 错误归一化策略：
  //   - 未知工具 / 参数非法 → 抛 RpcApplicationError（→ wire error -32602，client 拿到 RPC 错误）；
  //   - 工具自身抛错 → 返回 isError:true 的正常响应（MCP 约定：工具错误是 payload，不是 RPC 错误）；
  //   - 这层刻意不回显原始错误消息，避免泄露内部细节。
  async call(
    name: string,
    rawArguments: JsonObject,
    context: McpToolContext,
  ) {
    const tool = this.#tools.get(name);
    if (tool === undefined) {
      throw new RpcApplicationError(-32602, `Unknown tool: ${name}`);
    }
    const parsed = tool.inputSchema.safeParse(rawArguments);
    if (!parsed.ok) {
      throw new RpcApplicationError(-32602, 'Invalid tool arguments', {
        issues: parsed.error.map((item) => ({
          pointer: item.pointer,
          message: item.message,
        })),
      });
    }
    try {
      const text = await tool.execute(parsed.value, context);
      // 执行完成后再次检查 abort：让取消能立即生效，即使 execute 自己没轮询 signal。
      context.signal.throwIfAborted();
      return { content: [{ type: 'text' as const, text }], isError: false };
    } catch (cause: unknown) {
      // 即便 execute 抛的是 abort，也用 throwIfAborted 把它转成真正的 AbortError；
      // 否则统一归一化成“工具执行失败”的脱敏消息。
      context.signal.throwIfAborted();
      return {
        content: [{ type: 'text' as const, text: 'Tool execution failed' }],
        isError: true,
      };
    }
  }
}

// McpServerState：服务端生命周期状态机。
// idle → awaiting_initialized（收到 initialize）→ operational（收到 initialized 通知）→ closed。
export type McpServerState =
  | 'idle'
  | 'awaiting_initialized'
  | 'operational'
  | 'closed';

// McpServerSession：在 JsonRpcServer 之上加 MCP 生命周期 + 工具分发。
export class McpServerSession<Tools extends readonly AnyMcpTool[]> {
  readonly #rpc: JsonRpcServer<typeof mcpMethodSchemas>;
  readonly #toolRegistry: McpToolRegistry<Tools>;
  #state: McpServerState = 'idle';

  constructor(
    transport: RpcTransport,
    tools: Tools,
    readonly serverInfo: { readonly name: string; readonly version: string },
  ) {
    this.#toolRegistry = new McpToolRegistry(tools);
    // 把 4 个 RPC method 各自绑定到本实例的方法。
    // tools/call 把 server 的 RpcRequestContext 转成 McpToolContext（只暴露 requestId + signal）。
    this.#rpc = new JsonRpcServer(
      transport,
      mcpMethodSchemas,
      {
        initialize: async (params) => this.#initialize(params.protocolVersion),
        ping: async () => ({}),
        'tools/list': async () => {
          this.#ensureOperational('tools/list');
          return { tools: this.#toolRegistry.descriptors() };
        },
        'tools/call': async (params, context) => {
          this.#ensureOperational('tools/call');
          return this.#toolRegistry.call(
            params.name,
            params.arguments ?? {},
            { requestId: context.requestId, signal: context.signal },
          );
        },
      },
      {
        // onNotification 只关心 initialized；其余 notification 在教学实现里忽略。
        onNotification: async (method) => {
          if (method !== 'notifications/initialized') return;
          // initialized 来早或来晚都是状态违规——关闭连接。
          if (this.#state !== 'awaiting_initialized') {
            const error = new McpLifecycleError(
              `initialized notification 出现在 ${this.#state} 状态`,
            );
            this.#state = 'closed';
            await this.#rpc.close(error);
            return;
          }
          this.#state = 'operational';
        },
      },
    );
  }

  get state(): McpServerState {
    return this.#rpc.closed ? 'closed' : this.#state;
  }

  get inFlightCount(): number {
    return this.#rpc.inFlightCount;
  }

  async close(reason: unknown = new Error('MCP server 主动关闭')): Promise<void> {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    await this.#rpc.close(reason);
  }

  // #initialize：处理 initialize 请求。
  // 只支持单一版本：匹配则原样回，不匹配也回本端版本，让 client 决定是否断开。
  #initialize(requestedVersion: string) {
    if (this.#state !== 'idle') {
      throw new RpcApplicationError(-32600, 'initialize must be the first request');
    }
    this.#state = 'awaiting_initialized';
    // 只支持一个版本：匹配就回相同版本，不匹配则回本端支持的版本供客户端决定是否断开。
    const negotiated = requestedVersion === MCP_PROTOCOL_VERSION
      ? requestedVersion
      : MCP_PROTOCOL_VERSION;
    return {
      protocolVersion: negotiated,
      capabilities: { tools: { listChanged: false } },
      serverInfo: this.serverInfo,
      instructions: '教学服务器：只实现 text tools/list 与 tools/call',
    };
  }

  // #ensureOperational：服务端自己的门禁。
  // 不能只依赖 client 门禁：恶意 client 可以绕过 McpClientSession 直接发原始 RPC。
  #ensureOperational(method: string): void {
    if (this.#state !== 'operational') {
      throw new RpcApplicationError(-32002, `${method} requires initialized session`);
    }
  }
}

// isCapabilityObject：判断一个 capability 值是否是“真存在”的对象。
// 区分 undefined / null / array 与真正的 capability 对象（如 { listChanged: false }）。
function isCapabilityObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
