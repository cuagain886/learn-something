/**
 * 第 33 课：JSON-RPC 关联器 + MCP 生命周期的可运行内存实验室。
 *
 * 运行：npm run lesson:mcp-protocol
 */

import assert from 'node:assert/strict';

import { array, number, object } from '../17-schema.js';
import {
  defineMcpTool,
  McpClientSession,
  McpServerSession,
  MCP_PROTOCOL_VERSION,
} from './mcp.js';
import { createMemoryTransportPair } from './transport.js';

const sumTool = defineMcpTool({
  name: 'sum',
  description: '计算有限数字数组的和',
  inputSchema: object({
    values: array(number(), { minItems: 1 }),
  }),
  async execute(input, context) {
    context.signal.throwIfAborted();
    return String(input.values.reduce((total, value) => total + value, 0));
  },
});

const transport = createMemoryTransportPair();
const server = new McpServerSession(
  transport.server,
  [sumTool] as const,
  { name: 'typescript-course-server', version: '1.0.0' },
);
const client = new McpClientSession(transport.client);

// MCP 允许 initialization 前 ping；普通能力请求则由 Session 状态机拒绝。
await client.ping();
await client.initialize({
  clientName: 'typescript-course-client',
  clientVersion: '1.0.0',
});
assert.equal(client.state, 'operational');
assert.equal(server.state, 'operational');

const listed = await client.listTools();
const called = await client.callTool({
  name: 'sum',
  arguments: { values: [1, 2, 3] },
});
// client Promise settle 与 server finally 清理属于相邻 microtask；让清理 continuation 运行。
await Promise.resolve();

assert.deepEqual(listed.tools.map((tool) => tool.name), ['sum']);
assert.deepEqual(called, {
  content: [{ type: 'text', text: '6' }],
  isError: false,
});
assert.equal(server.inFlightCount, 0);

console.log('=== 第 33 课：JSON-RPC / MCP 协议状态机 ===');
console.log({
  protocolVersion: MCP_PROTOCOL_VERSION,
  clientState: client.state,
  serverState: server.state,
  toolNames: listed.tools.map((tool) => tool.name),
  result: called.content[0]?.text,
  pendingRequests: client.pendingCount,
  serverInFlight: server.inFlightCount,
});

await client.close();
assert.equal(client.state, 'closed');
