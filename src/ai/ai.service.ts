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
import { clampDays, clampLimit, rowToNumbers, toNumbers } from 'src/core/utils/sql';
import { ChatDto } from './dto/chat.dto';
import { AiConversation } from './entities/ai-conversation.entity';
import { AiMessage } from './entities/ai-message.entity';
import { AiUsage } from './entities/ai-usage.entity';
import { TrackEvent } from 'src/track/entities/track-event.entity';
import { TrackService } from 'src/track/track.service';

/** 会话列表项 */
export interface ConversationItem {
  id: string;
  title: string | null;
  create_time: Date;
  update_time: Date;
  message_count?: number;
}

/** SSE 事件名，与 anime-ai 的 SseEvent 一一对应 */
/** 一个 AI 对话请求对应的事件名（前后端埋点共用这张表） */
const EV_AI_CHAT = 'ai.chat';

/** 请求终态。client_abort 单列，避免用户中途离开被算成服务错误 */
type AiEventStatus = 'ok' | 'error' | 'client_abort';

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
    @InjectRepository(TrackEvent)
    private readonly trackRepo: Repository<TrackEvent>,
    private readonly trackService: TrackService,
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

  // ── 用量统计（管理员看板用，见 docs 里的「后续管理员界面」）─────

  /**
   * 总览。
   *
   * `client_abort` 单列：用户中途关页面/点停止不该算进错误率，否则会冤枉服务质量。
   *
   * 数据来自通用埋点表 `track_event`（`event = 'ai.chat'`），数值属性存在 `props` JSON 里，
   * 所以要用 `props->>'$.xxx'` 提取。可读性不如专用表，但换来「前后端埋点共用一张表」。
   * 量级上来后应先加物化汇总表，而不是给通用表加业务列。
   */
  async statsOverview() {
    const [row] = (await this.trackRepo.query(
      `SELECT COUNT(*)                                                AS total_requests,
              SUM(props->>'$.status' = 'ok')                          AS ok_requests,
              SUM(props->>'$.status' = 'error')                       AS error_requests,
              SUM(props->>'$.status' = 'client_abort')                AS aborted_requests,
              COALESCE(SUM(CAST(props->>'$.promptTokens' AS UNSIGNED)), 0)     AS prompt_tokens,
              COALESCE(SUM(CAST(props->>'$.completionTokens' AS UNSIGNED)), 0) AS completion_tokens,
              COALESCE(SUM(CAST(props->>'$.toolCalls' AS UNSIGNED)), 0)        AS tool_calls,
              COUNT(DISTINCT user_id)                                 AS users,
              COALESCE(ROUND(AVG(CAST(props->>'$.latencyMs' AS UNSIGNED))), 0)    AS avg_latency_ms,
              COALESCE(ROUND(AVG(CAST(props->>'$.firstTokenMs' AS UNSIGNED))), 0) AS avg_first_token_ms,
              SUM(create_time >= CURDATE())                           AS today_requests
       FROM track_event
       WHERE event = ?`,
      [EV_AI_CHAT],
    )) as Array<Record<string, unknown>>;
    return row
      ? rowToNumbers(row, [
          'total_requests', 'ok_requests', 'error_requests', 'aborted_requests',
          'prompt_tokens', 'completion_tokens', 'tool_calls', 'users',
          'avg_latency_ms', 'avg_first_token_ms', 'today_requests',
        ])
      : {};
  }

  /** 按天趋势，默认最近 14 天 */
  async statsDaily(days = 14) {
    const safeDays = clampDays(days);
    const rows = (await this.trackRepo.query(
      // DATE_FORMAT 而不是 DATE()：DATE() 会以 Date 对象返回，JSON 化成 UTC 时间戳
      // （`2026-09-21` 变成 `2026-09-20T16:00:00Z`），看板上日期会整体差一天。
      `SELECT DATE_FORMAT(create_time, '%Y-%m-%d')                                      AS day,
              COUNT(*)                                                  AS requests,
              COUNT(DISTINCT user_id)                                   AS users,
              COALESCE(SUM(CAST(props->>'$.promptTokens' AS UNSIGNED)), 0)     AS prompt_tokens,
              COALESCE(SUM(CAST(props->>'$.completionTokens' AS UNSIGNED)), 0) AS completion_tokens,
              COALESCE(SUM(CAST(props->>'$.toolCalls' AS UNSIGNED)), 0)        AS tool_calls,
              COALESCE(ROUND(AVG(CAST(props->>'$.latencyMs' AS UNSIGNED))), 0) AS avg_latency_ms
       FROM track_event
       WHERE event = ? AND create_time >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY day
       ORDER BY day DESC`,
      [EV_AI_CHAT, safeDays],
    )) as Array<Record<string, unknown>>;
    return toNumbers(rows, [
      'requests', 'users', 'prompt_tokens', 'completion_tokens', 'tool_calls', 'avg_latency_ms',
    ]);
  }

  /**
   * 工具使用分布。
   *
   * 按「组合」分组（`browse_anime` 与 `browse_anime,search_anime` 各算一组），
   * 而不是拆成单个工具 —— MySQL 没有内置字符串拆分，为此拉全表到应用层聚合不划算。
   * 组合视角本身也有信息量：能看出模型是否倾向一轮连调多个工具。
   */
  async statsTools(days = 14) {
    const safeDays = clampDays(days);
    const rows = (await this.trackRepo.query(
      `SELECT COALESCE(NULLIF(props->>'$.toolNames', '[]'), '(无工具)') AS tools,
              COUNT(*)                                                  AS requests,
              COALESCE(SUM(CAST(props->>'$.toolCalls' AS UNSIGNED)), 0)  AS calls
       FROM track_event
       WHERE event = ? AND create_time >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY tools
       ORDER BY requests DESC
       LIMIT 20`,
      [EV_AI_CHAT, safeDays],
    )) as Array<Record<string, unknown>>;
    return toNumbers(rows, ['requests', 'calls']);
  }

  /** 用量最高的用户，便于发现异常账号 */
  async statsTopUsers(days = 14, limit = 20) {
    const safeDays = clampDays(days);
    const safeLimit = clampLimit(limit, 20, 100);
    const rows = (await this.trackRepo.query(
      // 注意 `+` 两侧都要各自 CAST：`props->>` 取出来是**字符串**，
      // 不 CAST 的话 `+` 会做字符串拼接，SUM 出来的结果毫无意义（本开发过程中踩到 500）。
      `SELECT user_id,
              COUNT(*) AS requests,
              COALESCE(SUM(CAST(props->>'$.promptTokens' AS UNSIGNED)
                         + CAST(props->>'$.completionTokens' AS UNSIGNED)), 0) AS tokens
       FROM track_event
       WHERE event = ? AND create_time >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY user_id
       ORDER BY requests DESC
       LIMIT ?`,
      [EV_AI_CHAT, safeDays, safeLimit],
    )) as Array<Record<string, unknown>>;
    return toNumbers(rows, ['requests', 'tokens']);
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

    // ── 遥测（写 ai_request_log 用）──────────────────────────
    const startedAt = Date.now();
    /** 首字延迟：比整轮耗时更贴近「体感快不快」 */
    let firstTokenMs: number | null = null;
    const toolNames = new Set<string>();
    let toolCalls = 0;
    let status: AiEventStatus = 'ok';
    let finishReason: string | null = null;
    let model: string | null = null;
    /** 上游是否已正常收尾；未收尾就 close = 用户中途跑了 */
    let upstreamEnded = false;

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
        // 明细改为**埋点事件**上报：与前端行为埋点共用一条写入路径与一张表，
        // 管理员看板就不必为「AI 明细」单独写一套查询。
        await this.trackService.trackOne(EV_AI_CHAT, {
          userId,
          page: 'Ai',
          target: 'chat',
          props: {
            conversationId,
            model,
            promptTokens,
            completionTokens,
            toolCalls,
            toolNames: toolNames.size ? [...toolNames] : [],
            latencyMs: Date.now() - startedAt,
            firstTokenMs,
            status,
            finishReason,
            // 工具命中条数：能看出「模型取了多少候选才筛出推荐」
            candidateCount: subjects.length,
          },
        });
      } catch (e) {
        // 落库失败不能影响已完成的对话；但要留痕，否则配额与历史会静默错账
        this.logger.error(
          `落库 AI 消息失败: ${e instanceof Error ? e.message : e}`,
        );
      }
    };

    return new Promise<void>((resolve) => {
      const onClose = () => {
        // 客户端断开（关页面/切走）：停掉上游，但仍要落库已生成的内容与用量。
        // 上游还没收尾就说明是用户中途跑了，单独标 client_abort ——
        // 把它算进「错误率」会冤枉服务质量。
        if (!upstreamEnded) {
          status = 'client_abort';
        }
        upstream.destroy();
      };
      res.on('close', onClose);

      upstream.on('data', (chunk: Buffer) => {
        // 统一换行再解析：这样 `\n\n` 分块对 CRLF 的上游也成立
        buffer += decoder.write(chunk).replace(/\r\n/g, '\n');
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const parsed = parseSseBlock(block);
          if (!parsed) {
            continue;
          }
          // **原样转发上游的事件块**。
          // 曾在这里重新拼成 `event: ${name}\ndata:${data}`，结果网关多出一个空格，
          // 与 anime-ai 直出的 `event:name` 不一致 —— 同一个协议出现两种线格式，
          // 排查时要分别对照。透传原始块就不会有这种偏差。
          if (!res.writableEnded) {
            res.write(`${block}\n\n`);
          }
          switch (parsed.event) {
            case EV.TEXT_DELTA: {
              const delta = asRecord(parsed.json)?.text ?? '';
              if (delta && firstTokenMs === null) {
                firstTokenMs = Date.now() - startedAt;
              }
              text += delta;
              break;
            }
            case EV.TOOL_RESULT: {
              const rec = asRecord(parsed.json);
              const list = rec?.subjects;
              if (Array.isArray(list)) {
                subjects = subjects.concat(list);
              }
              const name = rec?.name;
              if (typeof name === 'string' && name) {
                toolCalls += 1;
                toolNames.add(name);
              }
              break;
            }
            case EV.ERROR:
              status = 'error';
              break;
            case EV.DONE: {
              const d = asRecord(parsed.json);
              if (typeof d?.finishReason === 'string') {
                finishReason = d.finishReason;
              }
              if (typeof d?.model === 'string') {
                model = d.model;
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
        upstreamEnded = true;
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

/** 统计天数收敛到 1–90，避免把任意整数拼进 SQL 的 INTERVAL */

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
