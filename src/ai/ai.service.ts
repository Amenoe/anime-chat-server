import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import axios from 'axios';
import type { Response } from 'express';
import { Readable } from 'stream';
import { StringDecoder } from 'string_decoder';
import { Repository } from 'typeorm';
import { aiConfig } from 'src/core/config/config';
import { ChatDto } from './dto/chat.dto';
import { AiConversation } from './entities/ai-conversation.entity';
import { AiMessage } from './entities/ai-message.entity';
import { AiUsage } from './entities/ai-usage.entity';

/** 会话列表项 */
export interface ConversationItem {
  id: string;
  title: string | null;
  create_time: Date;
  update_time: Date;
  message_count?: number;
}

/** SSE 事件名，与 anime-ai 的 SseEvent 一一对应 */
const EV = {
  TEXT_DELTA: 'text-delta',
  TOOL_CALL: 'tool-call',
  TOOL_RESULT: 'tool-result',
  USAGE: 'usage',
  ERROR: 'error',
  DONE: 'done',
} as const;

/**
 * AI 网关服务。
 *
 * 职责：鉴权后的配额闸门、会话落库、把 anime-ai 的 SSE 透传给前端。
 * **不包含任何检索逻辑** —— 那是 anime-ai 的事（见 docs/ai-rag-practice-roadmap.md）。
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    @InjectRepository(AiConversation)
    private readonly conversationRepo: Repository<AiConversation>,
    @InjectRepository(AiMessage)
    private readonly messageRepo: Repository<AiMessage>,
    @InjectRepository(AiUsage)
    private readonly usageRepo: Repository<AiUsage>,
  ) {}

  // ── 会话查询 ────────────────────────────────────────────────

  async listConversations(userId: string): Promise<ConversationItem[]> {
    return this.conversationRepo.find({
      where: { user_id: userId },
      order: { update_time: 'DESC' },
      take: 50,
    });
  }

  async getMessages(
    userId: string,
    conversationId: string,
  ): Promise<AiMessage[]> {
    await this.findOwnedConversation(userId, conversationId);
    return this.messageRepo.find({
      where: { conversation_id: conversationId },
      order: { create_time: 'ASC' },
    });
  }

  async deleteConversation(
    userId: string,
    conversationId: string,
  ): Promise<void> {
    await this.findOwnedConversation(userId, conversationId);
    await this.messageRepo.delete({ conversation_id: conversationId });
    await this.conversationRepo.delete({ id: conversationId });
  }

  // ── 对话主流程 ──────────────────────────────────────────────

  /**
   * 处理一轮对话并把 SSE 写给客户端。
   *
   * 顺序很讲究，三点都是踩过的坑：
   * 1. **配额与会话准备都在写 SSE 响应头之前** —— 一旦写了 `text/event-stream` 头，
   *    超配额/上游不可用就只能靠 error 事件表达，拿不到真实状态码。
   * 2. **落库要等上游连通之后** —— 否则上游挂了会留下一堆「只有提问、没有回复」的空会话，
   *    污染用户的会话列表。
   * 3. **上游连不上要退回配额** —— 用户没拿到任何结果却被扣次数，是会被投诉的；
   *    退回也只发生在上游不可用（用户无法主动制造），所以不构成绕过配额的口子。
   */
  async streamChat(res: Response, userId: string, dto: ChatDto): Promise<void> {
    await this.consumeQuota(userId);

    // 已有会话需先校验归属；新会话等上游连通后再落库
    const existing = dto.conversationId
      ? await this.findOwnedConversation(userId, dto.conversationId)
      : null;

    const history = existing ? await this.recentMessages(existing.id) : [];
    const messages = [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user' as const, content: dto.message },
    ];

    // 先把上游接上再写 SSE 头，否则上游挂了就只能发 error 事件、拿不到真实状态码
    let upstream: { data: Readable };
    try {
      upstream = await this.openUpstream(existing?.id, messages);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '上游 AI 服务不可用';
      this.logger.error(`连接 anime-ai 失败: ${msg}`);
      await this.refundQuota(userId);
      throw new ServiceUnavailableException(`AI 服务暂时不可用：${msg}`);
    }

    const conversation =
      existing ??
      (await this.conversationRepo.save(
        this.conversationRepo.create({
          user_id: userId,
          title: dto.message.slice(0, 30),
        }),
      ));

    await this.messageRepo.save(
      this.messageRepo.create({
        conversation_id: conversation.id,
        user_id: userId,
        role: 'user',
        content: dto.message,
        tool_results: null,
      }),
    );

    this.writeSseHeaders(res, conversation.id);
    await this.pipeEvents(res, upstream.data, conversation.id);
    // 标题只在一轮完整结束后更新，避免半途失败留下空标题
    await this.touchConversation(conversation, dto.message);
  }

  // ── 配额 ────────────────────────────────────────────────────

  /**
   * 原子自增当日计数并校验配额。
   *
   * 用 `INSERT ... ON DUPLICATE KEY UPDATE` 而不是「读-改-写」：
   * 后者在并发下会丢更新（两个请求都读到 N 都写 N+1），配额形同虚设。
   *
   * 计数发生在**请求开始前**，所以用户中途断开也照样扣次数 ——
   * 否则「断开重连」就能绕过配额。
   *
   * 并发下可能略微超扣（多个请求都 +1 后都判定超限），这是**故意 fail-closed**：
   * 宁可少给几次，也不要账单失控。
   */
  private async consumeQuota(userId: string): Promise<void> {
    if (aiConfig.dailyQuota <= 0) {
      return;
    }
    const today = todayString();
    await this.usageRepo.query(
      `INSERT INTO ai_usage (user_id, stat_date, request_count, prompt_tokens, completion_tokens)
       VALUES (?, ?, 1, 0, 0)
       ON DUPLICATE KEY UPDATE request_count = request_count + 1`,
      [userId, today],
    );
    const [row] = (await this.usageRepo.query(
      `SELECT request_count FROM ai_usage WHERE user_id = ? AND stat_date = ?`,
      [userId, today],
    )) as Array<{ request_count: number }>;

    if (row && row.request_count > aiConfig.dailyQuota) {
      throw new HttpException(
        `今日 AI 对话次数已用完（${aiConfig.dailyQuota} 次/天），请明天再试`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * 上游连接失败时退回配额。
   *
   * 只在上游不可用时调用 —— 用户无法主动制造这种情况，
   * 因此不构成「断开重连绕过配额」的口子（那种情况计数保留）。
   */
  private async refundQuota(userId: string): Promise<void> {
    if (aiConfig.dailyQuota <= 0) {
      return;
    }
    await this.usageRepo.query(
      `UPDATE ai_usage SET request_count = GREATEST(request_count - 1, 0)
       WHERE user_id = ? AND stat_date = ?`,
      [userId, todayString()],
    );
  }

  /** token 用量在流结束后累加；拿不到就只记次数 */
  private async addTokens(
    userId: string,
    promptTokens: number,
    completionTokens: number,
  ): Promise<void> {
    if (promptTokens <= 0 && completionTokens <= 0) {
      return;
    }
    await this.usageRepo.query(
      `UPDATE ai_usage SET prompt_tokens = prompt_tokens + ?, completion_tokens = completion_tokens + ?
       WHERE user_id = ? AND stat_date = ?`,
      [promptTokens, completionTokens, userId, todayString()],
    );
  }

  // ── 会话读写 ────────────────────────────────────────────────

  private async findOwnedConversation(
    userId: string,
    conversationId: string,
  ): Promise<AiConversation> {
    const found = await this.conversationRepo.findOne({
      where: { id: conversationId, user_id: userId },
    });
    if (!found) {
      // 不区分「不存在」与「不属于你」，避免通过报错探测他人会话 id
      throw new NotFoundException('会话不存在');
    }
    return found;
  }

  private async touchConversation(
    conversation: AiConversation,
    firstMessage: string,
  ): Promise<void> {
    conversation.title = conversation.title ?? firstMessage.slice(0, 30);
    // update_time 由 @UpdateDateColumn 自动维护，这里显式 save 以触发它
    await this.conversationRepo.save(conversation);
  }

  /** 最近 N 条消息，按时间正序返回（送给模型的历史窗口） */
  private async recentMessages(conversationId: string): Promise<AiMessage[]> {
    const rows = await this.messageRepo.find({
      where: { conversation_id: conversationId },
      order: { create_time: 'DESC' },
      take: aiConfig.historyWindow,
    });
    return rows.reverse();
  }

  // ── 上游转发 ────────────────────────────────────────────────

  private async openUpstream(
    conversationId: string | undefined,
    messages: Array<{ role: string; content: string }>,
  ): Promise<{ data: Readable }> {
    const body = { conversationId, messages };
    const response = await axios.post(
      `${aiConfig.serviceUrl}/internal/ai/chat`,
      body,
      {
        responseType: 'stream',
        // 流式响应不能设总超时，否则长回答会被中途掐断；
        // 用 timeout 只约束建连/首字节（axios 在收到响应头后即停止计时）
        timeout: aiConfig.upstreamTimeoutMs,
        headers: {
          'Content-Type': 'application/json',
          ...(aiConfig.internalToken
            ? { 'X-Internal-Token': aiConfig.internalToken }
            : {}),
        },
        validateStatus: () => true,
      },
    );

    if (response.status !== HttpStatus.OK) {
      const detail = await readStreamSnippet(response.data);
      throw new Error(`anime-ai 返回 ${response.status} ${detail}`);
    }
    return response as unknown as { data: Readable };
  }

  private writeSseHeaders(res: Response, conversationId: string): void {
    res.status(HttpStatus.OK);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // nginx 默认会缓冲响应，导致前端拿到「一次性吐出」而不是流式
    res.setHeader('X-Accel-Buffering', 'no');
    // 新建会话时前端需要立刻知道 conversationId，才能继续追问
    res.setHeader('X-Conversation-Id', conversationId);
    res.flushHeaders();
  }

  /**
   * 解析上游 SSE、原样转发给前端，同时累计要落库的内容。
   *
   * 为什么不用管道直通：必须在转发的同时**解析**出文本、番剧卡片与 token 用量，
   * 否则无法落库与计费。解析用 StringDecoder 而不是 `chunk.toString()` ——
   * 中文是多字节，跨 chunk 截断时 `toString()` 会产生乱码。
   */
  private async pipeEvents(
    res: Response,
    upstream: Readable,
    conversationId: string,
  ): Promise<void> {
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let text = '';
    let subjects: unknown[] = [];
    let promptTokens = 0;
    let completionTokens = 0;
    let finished = false;

    const userId = (res.req as unknown as { user?: { user_id: string } })?.user
      ?.user_id;

    const finalize = async () => {
      if (finished) {
        return;
      }
      finished = true;
      try {
        if (text.trim()) {
          await this.messageRepo.save(
            this.messageRepo.create({
              conversation_id: conversationId,
              user_id: userId ?? '',
              role: 'assistant',
              content: text,
              tool_results: subjects.length ? subjects : null,
            }),
          );
        }
        if (userId) {
          await this.addTokens(userId, promptTokens, completionTokens);
        }
      } catch (e) {
        // 落库失败不能影响已完成的对话；但要留痕，否则配额与历史会静默错账
        this.logger.error(
          `落库 AI 消息失败: ${e instanceof Error ? e.message : e}`,
        );
      }
    };

    return new Promise<void>((resolve) => {
      const onClose = () => {
        // 客户端断开（关页面/切走）：停掉上游，但仍要落库已生成的内容与用量
        upstream.destroy();
      };
      res.on('close', onClose);

      upstream.on('data', (chunk: Buffer) => {
        buffer += decoder.write(chunk);
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const parsed = parseSseBlock(block);
          if (!parsed) {
            continue;
          }
          // 原样转发（保持 `data:` 后无空格，与 anime-ai 一致）
          if (!res.writableEnded) {
            res.write(`event: ${parsed.event}\ndata:${parsed.data}\n\n`);
          }
          switch (parsed.event) {
            case EV.TEXT_DELTA:
              text += asRecord(parsed.json)?.text ?? '';
              break;
            case EV.TOOL_RESULT: {
              const list = asRecord(parsed.json)?.subjects;
              if (Array.isArray(list)) {
                subjects = subjects.concat(list);
              }
              break;
            }
            case EV.USAGE: {
              const u = asRecord(parsed.json);
              promptTokens = Number(u?.promptTokens ?? 0) || 0;
              completionTokens = Number(u?.completionTokens ?? 0) || 0;
              break;
            }
            default:
              break;
          }
        }
      });

      upstream.on('end', () => {
        void (async () => {
          await finalize();
          res.off('close', onClose);
          if (!res.writableEnded) {
            res.end();
          }
          resolve();
        })();
      });

      upstream.on('error', (err: Error) => {
        void (async () => {
          this.logger.error(`上游流中断: ${err.message}`);
          if (!res.writableEnded) {
            res.write(
              `event: ${EV.ERROR}\ndata:${JSON.stringify({
                message: 'AI 服务连接中断',
              })}\n\n`,
            );
          }
          await finalize();
          res.off('close', onClose);
          if (!res.writableEnded) {
            res.end();
          }
          resolve();
        })();
      });
    });
  }
}

// ── 辅助函数 ──────────────────────────────────────────────────

/** 本地日期 YYYY-MM-DD（按服务器本地时区，与用户感知的「今天」一致） */
function todayString(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

interface ParsedSse {
  event: string;
  data: string;
  json: unknown;
}

/** 解析一个 SSE 块；无 data 行返回 null */
function parseSseBlock(block: string): ParsedSse | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      // SSE 规范允许 `data: xxx`（带一个空格）或 `data:xxx`，两种都要吃
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (!dataLines.length) {
    return null;
  }
  const data = dataLines.join('\n');
  let json: unknown = null;
  try {
    json = JSON.parse(data);
  } catch {
    json = null;
  }
  return { event, data, json };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

/** 读取一小段流内容用于错误信息（上游非 200 时的响应体） */
async function readStreamSnippet(stream: Readable): Promise<string> {
  return new Promise((resolve) => {
    let acc = '';
    const done = () => resolve(acc.slice(0, 200));
    stream.on('data', (c: Buffer) => {
      acc += c.toString('utf8');
    });
    stream.on('end', done);
    stream.on('error', done);
    setTimeout(done, 1000);
  });
}
