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

// SseRecord：解析层输出的「一条 SSE 协议记录」。
// 一种是正常 event（带 event/data/id），另一种是 retry（服务器建议重连等待）。
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

// AgentStreamEvent：把 SSE 上的 data JSON 解析成业务侧的 token / usage 两种事件。
type AgentStreamEvent =
  | { readonly type: 'token'; readonly delta: string }
  | {
      readonly type: 'usage';
      readonly inputTokens: number;
      readonly outputTokens: number;
    };

// StreamStats：用来观察底层 ReadableStream 的 pull/cancel 调用次数与取消原因。
type StreamStats = {
  pullCount: number;
  cancelCount: number;
  cancelReason: unknown;
};

// ------------------------------------------------------------
// 1. 为什么不能逐 chunk 创建新 TextDecoder
// ------------------------------------------------------------
// encoder 用来把字符串编码为 UTF-8 字节，制造后续实验用的「分块字节流」。
const encoder = new TextEncoder();
// 中文「你」在 UTF-8 下占 3 个字节，刻意用来制造「字符跨 chunk」的场景。
const chineseCharacter = encoder.encode('你'); // UTF-8 中占 3 个字节
// 反例：每次都用全新的 TextDecoder 解码片段。每个新 decoder 都没有「未完成字节缓冲」，
// 因此不完整的字节会被替换为 U+FFFD（替换字符），最终拼不出原始字符。
const naive = [
  new TextDecoder().decode(chineseCharacter.slice(0, 1)),
  new TextDecoder().decode(chineseCharacter.slice(1)),
].join('');

// 正确做法：复用同一个 decoder，并配合 { stream: true } 让它跨调用保留未完成字节。
// fatal:true 让真正的非法字节抛错（更早发现问题），而不是默默替换。
const streamingDecoder = new TextDecoder('utf-8', { fatal: true });
// 前两次用 stream:true 保留缓冲；最后一次无参 decode() 触发缓冲里剩余字节的 flush。
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
// payload 是一段合法的 SSE 文本，刻意混用 CRLF/LF/CR，并把同一 JSON 拆到多行 data，
// 用来验证解析器对各种「拆分边界」的鲁棒性。
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

// 把 payload 编码成字节，并按 [1,2,5,3,8,1,13] 这些「人为指定大小」的 chunk 切分。
// 这模拟了「网络层 chunk 边界完全随机」的现实情况。
const { stream, stats } = createChunkedByteStream(
  encoder.encode(payload),
  [1, 2, 5, 3, 8, 1, 13],
);

// ------------------------------------------------------------
// 3. 分层消费：每层只解决一个协议问题
// ------------------------------------------------------------
// parsedEvents 收集最终解析出的 AgentStreamEvent，作为对解析管线的断言对象。
const parsedEvents: AgentStreamEvent[] = [];

// 三层 async generator 嵌套：字节 → 文本 → 行 → SSE record。
// 每一层都用 for await 消费上游，自然形成背压：消费者慢，底层 pull 就被推迟。
for await (const record of parseSse(splitLines(decodeUtf8(stream)))) {
  // 模拟慢消费者。ReadableStream 会依据 desiredSize/highWaterMark 调用 pull，
  // 而不是要求生产者一次把所有字节塞入内存。
  await delay(1);

  // retry 是协议级建议，不是业务事件，单独打印后跳过。
  if (record.kind === 'retry') {
    console.log('服务器建议重连等待:', record.milliseconds);
    continue;
  }

  // [DONE] 是 OpenAI 风格的流结束标记，遇到就主动 break（会触发底层 cancel）。
  if (record.data === '[DONE]') {
    console.log('收到流结束标记，主动停止读取');
    break;
  }

  // 业务层校验：JSON 字段是否符合 AgentStreamEvent 的形状。
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
// 断言：业务侧最终只看到 3 条事件，与 payload 中的 token/usage 数量一致。
assert.deepEqual(parsedEvents, [
  { type: 'token', delta: '你' },
  { type: 'token', delta: '好' },
  { type: 'usage', inputTokens: 10, outputTokens: 2 },
]);
// 断言：因为遇到 [DONE] 主动 break，底层 stream 必然被 cancel 一次。
assert.equal(stats.cancelCount, 1, '提前 break 必须关闭底层 ReadableStream');

// ------------------------------------------------------------
// Byte Stream：pull 每次只交付一个人为切分的 chunk
// ------------------------------------------------------------
// createChunkedByteStream 构造一个可控的 ReadableStream：
// 每次被 pull 才推一个固定大小的 chunk 出去；cancel 时记录原因，便于断言。
function createChunkedByteStream(
  bytes: Uint8Array,
  chunkSizes: readonly number[],
): { readonly stream: ReadableStream<Uint8Array>; readonly stats: StreamStats } {
  // 入参校验：chunkSizes 必须是正整数数组，否则无法预测切分行为。
  if (chunkSizes.length === 0 || chunkSizes.some((size) => !Number.isInteger(size) || size < 1)) {
    throw new RangeError('chunkSizes 必须包含正整数');
  }

  // offset 跟踪已交付的字节位置；chunkIndex 在 chunkSizes 上循环取模。
  let offset = 0;
  let chunkIndex = 0;
  const stats: StreamStats = {
    pullCount: 0,
    cancelCount: 0,
    cancelReason: undefined,
  };

  const stream = new ReadableStream<Uint8Array>(
    {
      // pull 在消费者请求更多数据时被调用；本实现按 chunkSizes 切出固定大小的片段。
      pull(controller) {
        stats.pullCount += 1;
        // 字节全部交付完后，关闭流，让消费者读到 done。
        if (offset >= bytes.length) {
          controller.close();
          return;
        }

        // 按 chunkSizes 循环取出本次切分大小，保证 [1,2,5,3,8,1,13] 周期性复用。
        const requested = chunkSizes[chunkIndex % chunkSizes.length] ?? 1;
        chunkIndex += 1;
        // 末尾切片可能小于 requested，用 Math.min 收敛到 bytes.length。
        const end = Math.min(offset + requested, bytes.length);
        // enqueue 把字节进入内部队列，等待消费者 read。
        // slice 是必须的：ReadableStream 持有的 Uint8Array 不能与生产者共享可变缓冲。
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      },
      // cancel 在消费者提前停止读取（如遇到 [DONE] break）时被调用。
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
// decodeUtf8 是管线第一层：把字节流转成字符串流，复用同一个 decoder 维持 UTF-8 状态。
async function* decodeUtf8(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<string, void, void> {
  // 关键：decoder 在循环外创建，让「未完成字节」跨 chunk 保留。
  const decoder = new TextDecoder('utf-8', { fatal: true });

  for await (const chunk of chunks) {
    // stream:true 告诉 decoder「后面可能还有数据」，不要把不完整字节当错误处理。
    const text = decoder.decode(chunk, { stream: true });
    if (text !== '') yield text;
  }

  // 流结束后做一次无参 decode()，flush 出剩余缓冲里的字节（通常是完整的尾字符）。
  const tail = decoder.decode();
  if (tail !== '') yield tail;
}

// ------------------------------------------------------------
// Text → Lines：同时支持 CRLF、LF、CR，并允许换行符跨 chunk
// ------------------------------------------------------------
// splitLines 是管线第二层：逐字符扫描，把任意 CRLF/LF/CR 都识别为行结束符。
// 用 pendingCarriageReturn 处理「CR 在 chunk 末尾、LF 在下一个 chunk 开头」的边界。
async function* splitLines(
  chunks: AsyncIterable<string>,
): AsyncGenerator<string, void, void> {
  // line 累积当前未结束行的字符。
  let line = '';
  // pendingCarriageReturn 表示上一个字符是 CR，等待本行是否会被 LF 跟进。
  let pendingCarriageReturn = false;

  for await (const chunk of chunks) {
    for (const character of chunk) {
      // 上一轮以 CR 结尾，现在无论下一个字符是什么，都先把当前行 flush 出去。
      if (pendingCarriageReturn) {
        yield line;
        line = '';
        pendingCarriageReturn = false;
        // 如果跟的是 \n，说明刚才其实是 CRLF，应被合并成一次行结束（不产生空行）。
        if (character === '\n') continue; // CRLF 只产生一个行结束
      }

      // 单独 CR 标记「等待下一个字符」，可能是 CRLF 也可能是单独 CR 结束。
      if (character === '\r') pendingCarriageReturn = true;
      else if (character === '\n') {
        // LF 直接结束当前行。
        yield line;
        line = '';
      } else line += character;
    }
  }

  // 流末处理：若以 CR 结尾（没有后续字符），也要把累积的行输出。
  if (pendingCarriageReturn) yield line;
  else if (line !== '') yield line;
}

// ------------------------------------------------------------
// Lines → SSE：空行 dispatch；data 多行用 \n 连接；id 跨事件保留
// ------------------------------------------------------------
// parseSse 是管线第三层：按 SSE 规则把「行」归纳成 SseRecord。
// 三条核心规则：空行触发 dispatch、多行 data 用 \n 连接、lastEventId 跨事件保留。
async function* parseSse(
  lines: AsyncIterable<string>,
): AsyncGenerator<SseRecord, void, void> {
  // dataLines 累积同一事件的多行 data 字段，最后用 \n 连接。
  let dataLines: string[] = [];
  // eventType 默认空字符串；dispatch 时若仍为空，按规范回落为 'message'。
  let eventType = '';
  // lastEventId 是有状态的：上一个事件设置的 id 会被后续事件继承（用于断线重连）。
  let lastEventId = '';

  for await (const line of lines) {
    // 空行 = 事件结束，触发 dispatch。
    if (line === '') {
      // 只有至少有一行 data 才视为有效事件，否则仅作为分隔。
      if (dataLines.length > 0) {
        yield {
          kind: 'event',
          event: eventType === '' ? 'message' : eventType,
          data: dataLines.join('\n'),
          id: lastEventId,
        };
      }
      // 重置 event/data，但 lastEventId 跨事件保留。
      dataLines = [];
      eventType = '';
      continue;
    }

    // 以 ':' 开头的是注释/心跳，规范要求忽略。
    if (line.startsWith(':')) continue; // 注释/心跳

    // 解析「field: value」格式；field 不带冒号时整行作为 field、value 为空。
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    // 规范规定 value 前的一个空格是可选分隔符，只去掉一个空格而不是全部。
    if (value.startsWith(' ')) value = value.slice(1); // 只去掉一个可选空格

    switch (field) {
      case 'data':
        // 多行 data 累积起来，dispatch 时用 \n 连接。
        dataLines.push(value);
        break;
      case 'event':
        // 设置事件名（影响 dispatch 时的 event 字段）。
        eventType = value;
        break;
      case 'id':
        // SSE 规范：id 中若含 U+0000 NULL 则忽略，否则更新 lastEventId。
        if (!value.includes('\0')) lastEventId = value;
        break;
      case 'retry':
        // 仅当 value 是纯整数时才作为重连等待建议输出。
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

// ValidationResult 是 parseAgentStreamEvent 的返回形状：成功带值，失败带原因。
// 用判别联合 + ok 标志位让调用方必须先收窄再访问 value/issue。
type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issue: string };

// parseAgentStreamEvent 是业务层校验：把 SSE data 的字符串解析成 AgentStreamEvent。
// 注意每一层 narrow 都要做：JSON 解析 → 是否对象 → 是否有 type → 字段类型是否匹配。
function parseAgentStreamEvent(data: string): ValidationResult<AgentStreamEvent> {
  let raw: unknown;
  try {
    raw = JSON.parse(data) as unknown;
  } catch (error: unknown) {
    // JSON 语法错误不能让管线崩溃，而是返回失败结果让消费者决定如何记录。
    return {
      ok: false,
      issue: `JSON 语法错误: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // 第一层 narrow：必须是对象、不能是 null、必须带 type 字段。
  if (typeof raw !== 'object' || raw === null || !('type' in raw)) {
    return { ok: false, issue: '事件必须是带 type 的对象' };
  }

  // 第二层 narrow：type === 'token' 时还必须有 string 类型的 delta。
  if (raw.type === 'token' && 'delta' in raw && typeof raw.delta === 'string') {
    return { ok: true, value: { type: 'token', delta: raw.delta } };
  }

  // 第三层 narrow：type === 'usage' 时两个字段都必须是有限数字。
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

  // 既不是 token 也不是 usage 的合法对象，统一作为「未知事件」拒绝。
  return { ok: false, issue: '未知或字段不合法的 Agent stream event' };
}

// delay 用来模拟慢消费者，制造 backpressure，让 ReadableStream 的 pull 行为可观察。
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

console.log('=== 第 24 课完成：字节边界、协议边界和类型边界已逐层分离 ===');

export {};
