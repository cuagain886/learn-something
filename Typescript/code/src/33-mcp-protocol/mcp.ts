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

const capabilitiesSchema = jsonObjectSchema('协商后的 MCP capability bag');
const implementationSchema = object({
  name: string({ minLength: 1 }),
  version: string({ minLength: 1 }),
  title: optional(string({ minLength: 1 })),
  description: optional(string({ minLength: 1 })),
  websiteUrl: optional(string({ minLength: 1 })),
}, { unknownKeys: 'strip' });

const initializeParamsSchema = object({
  protocolVersion: string({ minLength: 1 }),
  capabilities: capabilitiesSchema,
  clientInfo: implementationSchema,
});

const initializeResultSchema = object({
  protocolVersion: string({ minLength: 1 }),
  capabilities: capabilitiesSchema,
  serverInfo: implementationSchema,
  instructions: optional(string()),
});

const emptyObjectSchema = object({});
const toolNameSchema = string({
  minLength: 1,
  pattern: /^[A-Za-z0-9_.-]{1,128}$/,
});
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

export type McpClientState =
  | 'idle'
  | 'initializing'
  | 'operational'
  | 'closed';

export class McpLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpLifecycleError';
  }
}

export class McpClientSession {
  readonly #rpc: JsonRpcClient<typeof mcpMethodSchemas>;
  #state: McpClientState = 'idle';
  #serverCapabilities: JsonObject | undefined;

  constructor(transport: RpcTransport) {
    this.#rpc = new JsonRpcClient(transport, mcpMethodSchemas);
  }

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
      if (!supported.has(result.protocolVersion)) {
        throw new McpLifecycleError(
          `server 选择了不支持的 protocolVersion ${result.protocolVersion}`,
        );
      }
      if (
        options.requireToolsCapability !== false
        && !isCapabilityObject(result.capabilities['tools'])
      ) {
        throw new McpLifecycleError('server 没有协商 tools capability');
      }
      this.#serverCapabilities = result.capabilities;
      await this.#rpc.notify('notifications/initialized');
      this.#state = 'operational';
    } catch (cause: unknown) {
      this.#state = 'closed';
      await this.#rpc.close(cause);
      throw cause;
    }
  }

  listTools(
    params: { readonly cursor?: string } = {},
    options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
  ) {
    this.#ensureOperational('tools/list', 'tools');
    return this.#rpc.request('tools/list', params, options);
  }

  callTool(
    params: { readonly name: string; readonly arguments?: JsonObject },
    options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
  ) {
    this.#ensureOperational('tools/call', 'tools');
    return this.#rpc.request('tools/call', params, options);
  }

  async close(reason: unknown = new Error('MCP client 主动关闭')): Promise<void> {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    await this.#rpc.close(reason);
  }

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

export type McpToolContext = {
  readonly requestId: RequestId;
  readonly signal: AbortSignal;
};

export interface McpToolDefinition<Name extends string, Input> {
  readonly name: Name;
  readonly description: string;
  readonly inputSchema: Schema<Input>;
  execute(input: Input, context: McpToolContext): string | Promise<string>;
  readonly __input?: Input;
}

export type AnyMcpTool = McpToolDefinition<string, unknown>;

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

class McpToolRegistry<Tools extends readonly AnyMcpTool[]> {
  readonly #tools = new Map<string, AnyMcpTool>();

  constructor(tools: Tools) {
    for (const tool of tools) {
      if (this.#tools.has(tool.name)) throw new Error(`MCP tool 重名: ${tool.name}`);
      this.#tools.set(tool.name, tool);
    }
  }

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
      context.signal.throwIfAborted();
      return { content: [{ type: 'text' as const, text }], isError: false };
    } catch (cause: unknown) {
      context.signal.throwIfAborted();
      return {
        content: [{ type: 'text' as const, text: 'Tool execution failed' }],
        isError: true,
      };
    }
  }
}

export type McpServerState =
  | 'idle'
  | 'awaiting_initialized'
  | 'operational'
  | 'closed';

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
        onNotification: async (method) => {
          if (method !== 'notifications/initialized') return;
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

  #ensureOperational(method: string): void {
    if (this.#state !== 'operational') {
      throw new RpcApplicationError(-32002, `${method} requires initialized session`);
    }
  }
}

function isCapabilityObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
