/**
 * ============================================================
 * 第 24 课：Agent 流式协议 —— UTF-8 分块、Web Streams 与 SSE 解析
 * ============================================================
 *
 * 网络 chunk 边界与业务消息边界没有任何关系：
 *   - 一个 UTF-8 字符可能跨多个 Uint8Array
 *   - CRLF 可能被拆成两个 chunk
 *   - 一个 SSE event 可能有多行 data
 *   - 一个 chunk 也可能包含多个 event
 *
 * 本课从字节流开始，逐层构建：
 *   Uint8Array → 增量 UTF-8 文本 → 行 → SSE record → Agent 事件
 *
 * 运行：npm run lesson:streaming
 */

import assert from 'node:assert/strict';
import { ReadableStream } from 'node:stream/web';

type SseRecord =
  | {
      readonly kind: 'event';
      readonly event: string;
      readonly data: string;
      readonly id: string;
    }
  | {
      readonly kind: 'retry';
      readonly milliseconds: number;
    };

type AgentStreamEvent =
  | { readonly type: 'token'; readonly delta: string }
  | {
      readonly type: 'usage';
      readonly inputTokens: number;
      readonly outputTokens: number;
    };

type StreamStats = {
  pullCount: number;
  cancelCount: number;
  cancelReason: unknown;
};

// ------------------------------------------------------------
// 1. 为什么不能逐 chunk 创建新 TextDecoder
// ------------------------------------------------------------
const encoder = new TextEncoder();
const chineseCharacter = encoder.encode('你'); // UTF-8 中占 3 个字节
const naive = [
  new TextDecoder().decode(chineseCharacter.slice(0, 1)),
  new TextDecoder().decode(chineseCharacter.slice(1)),
].join('');

const streamingDecoder = new TextDecoder('utf-8', { fatal: true });
const correct = streamingDecoder.decode(chineseCharacter.slice(0, 1), { stream: true })
  + streamingDecoder.decode(chineseCharacter.slice(1), { stream: true })
  + streamingDecoder.decode();

console.log('逐块独立解码:', JSON.stringify(naive));
console.log('保持 Decoder 状态:', JSON.stringify(correct));
assert.notEqual(naive, '你');
assert.equal(correct, '你');

// ------------------------------------------------------------
// 2. 构造故意破坏边界的 SSE 字节流
// ------------------------------------------------------------
const payload = [
  ': heartbeat\r\n',
  'retry: 1500\r\n',
  '\r\n',
  'id: 1\r\n',
  'event: token\r\n',
  'data: {"type":"token","delta":"你"}\r\n',
  '\r\n',
  'id: 2\n',
  'event: token\n',
  'data: {"type":"token",\n',
  'data: "delta":"好"}\n',
  '\n',
  // 这里使用单独 CR 作为行结束符，验证解析器不只支持 \n。
  'event: usage\r',
  'data: {"type":"usage","inputTokens":10,"outputTokens":2}\r',
  '\r',
  'data: [DONE]\r\n',
  '\r\n',
  // 消费者看到 DONE 后会 break；这些尾部字节应触发底层 stream cancel，而不是继续读取。
  ': should-not-be-consumed\r\n\r\n',
].join('');

const { stream, stats } = createChunkedByteStream(
  encoder.encode(payload),
  [1, 2, 5, 3, 8, 1, 13],
);

// ------------------------------------------------------------
// 3. 分层消费：每层只解决一个协议问题
// ------------------------------------------------------------
const parsedEvents: AgentStreamEvent[] = [];

for await (const record of parseSse(splitLines(decodeUtf8(stream)))) {
  // 模拟慢消费者。ReadableStream 会依据 desiredSize/highWaterMark 调用 pull，
  // 而不是要求生产者一次把所有字节塞入内存。
  await delay(1);

  if (record.kind === 'retry') {
    console.log('服务器建议重连等待:', record.milliseconds);
    continue;
  }

  if (record.data === '[DONE]') {
    console.log('收到流结束标记，主动停止读取');
    break;
  }

  const event = parseAgentStreamEvent(record.data);
  if (!event.ok) {
    console.log('拒绝非法流事件:', event.issue);
    continue;
  }

  parsedEvents.push(event.value);
  console.log('Agent stream event:', record.id, record.event, event.value);
}

console.log('最终事件:', parsedEvents);
console.log('底层流统计:', stats);
assert.deepEqual(parsedEvents, [
  { type: 'token', delta: '你' },
  { type: 'token', delta: '好' },
  { type: 'usage', inputTokens: 10, outputTokens: 2 },
]);
assert.equal(stats.cancelCount, 1, '提前 break 必须关闭底层 ReadableStream');

// ------------------------------------------------------------
// Byte Stream：pull 每次只交付一个人为切分的 chunk
// ------------------------------------------------------------
function createChunkedByteStream(
  bytes: Uint8Array,
  chunkSizes: readonly number[],
): { readonly stream: ReadableStream<Uint8Array>; readonly stats: StreamStats } {
  if (chunkSizes.length === 0 || chunkSizes.some((size) => !Number.isInteger(size) || size < 1)) {
    throw new RangeError('chunkSizes 必须包含正整数');
  }

  let offset = 0;
  let chunkIndex = 0;
  const stats: StreamStats = {
    pullCount: 0,
    cancelCount: 0,
    cancelReason: undefined,
  };

  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        stats.pullCount += 1;
        if (offset >= bytes.length) {
          controller.close();
          return;
        }

        const requested = chunkSizes[chunkIndex % chunkSizes.length] ?? 1;
        chunkIndex += 1;
        const end = Math.min(offset + requested, bytes.length);
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      },
      cancel(reason) {
        stats.cancelCount += 1;
        stats.cancelReason = reason;
      },
    },
    // 0 表示队列不主动预取；只有消费者 read 后 desiredSize 才推动 pull。
    { highWaterMark: 0 },
  );

  return { stream, stats };
}

// ------------------------------------------------------------
// Bytes → Text：同一个 Decoder 跨 chunk 保留未完成的多字节序列
// ------------------------------------------------------------
async function* decodeUtf8(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<string, void, void> {
  const decoder = new TextDecoder('utf-8', { fatal: true });

  for await (const chunk of chunks) {
    const text = decoder.decode(chunk, { stream: true });
    if (text !== '') yield text;
  }

  const tail = decoder.decode();
  if (tail !== '') yield tail;
}

// ------------------------------------------------------------
// Text → Lines：同时支持 CRLF、LF、CR，并允许换行符跨 chunk
// ------------------------------------------------------------
async function* splitLines(
  chunks: AsyncIterable<string>,
): AsyncGenerator<string, void, void> {
  let line = '';
  let pendingCarriageReturn = false;

  for await (const chunk of chunks) {
    for (const character of chunk) {
      if (pendingCarriageReturn) {
        yield line;
        line = '';
        pendingCarriageReturn = false;
        if (character === '\n') continue; // CRLF 只产生一个行结束
      }

      if (character === '\r') pendingCarriageReturn = true;
      else if (character === '\n') {
        yield line;
        line = '';
      } else line += character;
    }
  }

  if (pendingCarriageReturn) yield line;
  else if (line !== '') yield line;
}

// ------------------------------------------------------------
// Lines → SSE：空行 dispatch；data 多行用 \n 连接；id 跨事件保留
// ------------------------------------------------------------
async function* parseSse(
  lines: AsyncIterable<string>,
): AsyncGenerator<SseRecord, void, void> {
  let dataLines: string[] = [];
  let eventType = '';
  let lastEventId = '';

  for await (const line of lines) {
    if (line === '') {
      if (dataLines.length > 0) {
        yield {
          kind: 'event',
          event: eventType === '' ? 'message' : eventType,
          data: dataLines.join('\n'),
          id: lastEventId,
        };
      }
      dataLines = [];
      eventType = '';
      continue;
    }

    if (line.startsWith(':')) continue; // 注释/心跳

    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1); // 只去掉一个可选空格

    switch (field) {
      case 'data':
        dataLines.push(value);
        break;
      case 'event':
        eventType = value;
        break;
      case 'id':
        if (!value.includes('\0')) lastEventId = value;
        break;
      case 'retry':
        if (/^[0-9]+$/u.test(value)) {
          yield { kind: 'retry', milliseconds: Number(value) };
        }
        break;
      default:
        // 未知字段按 SSE 协议忽略，保证向前兼容。
        break;
    }
  }

  // EOF 不等价于空行：没有完成 dispatch 的 data 必须丢弃。
}

type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issue: string };

function parseAgentStreamEvent(data: string): ValidationResult<AgentStreamEvent> {
  let raw: unknown;
  try {
    raw = JSON.parse(data) as unknown;
  } catch (error: unknown) {
    return {
      ok: false,
      issue: `JSON 语法错误: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (typeof raw !== 'object' || raw === null || !('type' in raw)) {
    return { ok: false, issue: '事件必须是带 type 的对象' };
  }

  if (raw.type === 'token' && 'delta' in raw && typeof raw.delta === 'string') {
    return { ok: true, value: { type: 'token', delta: raw.delta } };
  }

  if (
    raw.type === 'usage'
    && 'inputTokens' in raw
    && 'outputTokens' in raw
    && typeof raw.inputTokens === 'number'
    && Number.isFinite(raw.inputTokens)
    && typeof raw.outputTokens === 'number'
    && Number.isFinite(raw.outputTokens)
  ) {
    return {
      ok: true,
      value: {
        type: 'usage',
        inputTokens: raw.inputTokens,
        outputTokens: raw.outputTokens,
      },
    };
  }

  return { ok: false, issue: '未知或字段不合法的 Agent stream event' };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

console.log('=== 第 24 课完成：字节边界、协议边界和类型边界已逐层分离 ===');

export {};
