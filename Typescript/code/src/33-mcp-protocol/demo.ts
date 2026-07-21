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

// 定义一个 sum 工具：教学子集里工具只返回 text 内容（字符串）。
// inputSchema 复用 17-schema 的构造器；execute 内部检查 signal，让取消能即时生效。
const sumTool = defineMcpTool({
  name: 'sum',
  description: '计算有限数字数组的和',
  inputSchema: object({
    values: array(number(), { minItems: 1 }),
  }),
  async execute(input, context) {
    // 进入执行体先检查 abort：避免在已取消的请求上做无谓计算。
    context.signal.throwIfAborted();
    return String(input.values.reduce((total, value) => total + value, 0));
  },
});

// 用一对内存 transport 把 client 和 server 接到一起（同进程内通信）。
const transport = createMemoryTransportPair();
// server 注册工具表 + 自身实现信息。
const server = new McpServerSession(
  transport.server,
  [sumTool] as const,
  { name: 'typescript-course-server', version: '1.0.0' },
);
// client 只持有 transport 的一端；构造时不会发任何消息。
const client = new McpClientSession(transport.client);

// MCP 允许 initialization 前 ping；普通能力请求则由 Session 状态机拒绝。
await client.ping();
// 握手：client 发 initialize，server 回 result，client 再发 notifications/initialized。
await client.initialize({
  clientName: 'typescript-course-client',
  clientVersion: '1.0.0',
});
// 握手完成后两侧都应进入 operational。
assert.equal(client.state, 'operational');
assert.equal(server.state, 'operational');

// 两个能力请求：列出工具 + 调用工具。
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
// 确认 server 端的 inFlight 表已清空（response 发出 + finally 执行后）。
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

// 关闭 client 会联动关闭 transport 对端，server 也随之进入 closed。
await client.close();
assert.equal(client.state, 'closed');
