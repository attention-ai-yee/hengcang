/**
 * DeepSeek 搜索 / 抓取 / 对话客户端（AI 新闻监控，docs/hengcang_v2_allocation_fundamentals_thesis.md §7）。
 *
 * 接口以官方文档为准（api-docs.deepseek.com，Search / Fetch 于 2026-10-17 上线）：
 * - Search：POST /v1/tools/search，query 1–128 个字符，支持 site: / after: / before: / lang: 运算符；
 *   结果含 title、url、snippet、summary（约 600–800 字）、content、site_name、date（UTC RFC 3339，可能为 null）、
 *   authority（-1 未知，0–4）、rerank_score（0–3）。
 * - Fetch：POST /v1/tools/fetch，返回页面标题与 Markdown 正文；403 = 网站拒绝抓取，404 = 没有可用内容。
 * - Chat：POST /chat/completions，JSON 输出用 response_format: { type: "json_object" }，提示词里必须写明要 JSON。
 * - 408 / 429 / 5xx 按文档建议等待后重试；401（Key 无效）、402（余额不足）及其它 4xx 不重试。
 * 计费：Search、Fetch 各按每 1000 次成功请求 5 元，与对话 token 共用账户余额。
 *
 * API Key 只从服务端环境变量 DEEPSEEK_API_KEY 读取，不写日志、不进数据库。
 */
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-flash";

export interface DeepSeekSearchResult {
  title: string;
  url: string;
  snippet: string;
  summary: string;
  /** need_content=true 时的正文；拿不到时为空串 */
  content: string;
  siteName: string | null;
  /** 发布时间（UTC RFC 3339），未知为 null */
  date: string | null;
  /** -1 未知；0–4，≥ 3 为高权威 */
  authority: number;
  /** 0–3，综合相关性、权威度与新鲜度 */
  rerankScore: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** 新闻监控用到的三个能力；测试注入假实现，生产用 DeepSeekClient。 */
export interface NewsClient {
  readonly model: string;
  search(query: string, options?: { count?: number; needContent?: boolean }): Promise<DeepSeekSearchResult[]>;
  fetchPage(url: string): Promise<{ title: string; content: string }>;
  chatJson(messages: ChatMessage[]): Promise<unknown>;
}

export class DeepSeekError extends Error {
  constructor(
    /** HTTP 状态码；0 = 网络错误或超时；200 = 响应格式不对 */
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DeepSeekError";
  }

  get retryable(): boolean {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

/** 401 / 402 只给固定说明，不回显服务端原文（避免把 Key 片段之类的内容带进日志）。 */
const STATUS_HINTS: Record<number, string> = {
  401: "DeepSeek API Key 无效或缺失",
  402: "DeepSeek 账户余额不足，请充值",
  403: "目标网页拒绝抓取",
  404: "目标网页没有可用内容",
  429: "请求过于频繁",
};

export interface DeepSeekClientOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  retries?: number;
  retryDelayMs?: number;
}

export class DeepSeekClient implements NewsClient {
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retries: number;
  private readonly retryDelayMs: number;

  constructor(options: DeepSeekClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEEPSEEK_BASE_URL).replace(/\/+$/, "");
    this.model = options.model ?? DEEPSEEK_DEFAULT_MODEL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retries = Math.min(Math.max(options.retries ?? 2, 0), 5);
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
  }

  /**
   * 没有配置 DEEPSEEK_API_KEY 时返回 null（新闻监控显示「未配置」，其它功能不受影响）。
   * DEEPSEEK_BASE_URL 一般不用填：只在走自建网关或本地联调时覆盖官方地址。
   */
  static fromEnv(): DeepSeekClient | null {
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
    if (!apiKey) return null;
    return new DeepSeekClient({
      apiKey,
      model: process.env.DEEPSEEK_MODEL?.trim() || undefined,
      baseUrl: process.env.DEEPSEEK_BASE_URL?.trim() || undefined,
    });
  }

  async search(query: string, options: { count?: number; needContent?: boolean } = {}): Promise<DeepSeekSearchResult[]> {
    const body = await this.post("/v1/tools/search", {
      query,
      count: options.count ?? 10,
      need_content: options.needContent ?? false,
    }, 30_000);
    const results = body && typeof body === "object" ? (body as { results?: unknown }).results : undefined;
    if (!Array.isArray(results)) throw new DeepSeekError(200, "DeepSeek 搜索返回格式无效：缺少 results");
    return results.flatMap(parseSearchResult);
  }

  async fetchPage(url: string): Promise<{ title: string; content: string }> {
    const body = (await this.post("/v1/tools/fetch", { url }, 45_000)) as { title?: unknown; content?: unknown } | null;
    return {
      title: typeof body?.title === "string" ? body.title : "",
      content: typeof body?.content === "string" ? body.content : "",
    };
  }

  async chatJson(messages: ChatMessage[]): Promise<unknown> {
    const body = (await this.post("/chat/completions", {
      model: this.model,
      messages,
      response_format: { type: "json_object" },
      stream: false,
    }, 180_000)) as { choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }> } | null;
    const choice = body?.choices?.[0];
    if (choice?.finish_reason === "length") throw new DeepSeekError(200, "模型输出被截断（finish_reason=length）");
    const content = choice?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new DeepSeekError(200, "模型没有返回内容");
    try {
      return JSON.parse(content) as unknown;
    } catch {
      throw new DeepSeekError(200, "模型返回的不是有效 JSON");
    }
  }

  private async post(path: string, payload: unknown, timeoutMs: number): Promise<unknown> {
    let attempt = 0;
    while (true) {
      try {
        return await this.postOnce(path, payload, timeoutMs);
      } catch (error) {
        if (!(error instanceof DeepSeekError) || !error.retryable || attempt >= this.retries) throw error;
        await delay(this.retryDelayMs * 2 ** attempt);
        attempt += 1;
      }
    }
  }

  private async postOnce(path: string, payload: unknown, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (error) {
        throw new DeepSeekError(0, controller.signal.aborted
          ? `DeepSeek 请求超时（${Math.round(timeoutMs / 1000)} 秒）`
          : `连接 DeepSeek 失败：${error instanceof Error ? error.message : String(error)}`);
      }
      const text = await response.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      if (!response.ok) {
        const hint = STATUS_HINTS[response.status];
        const detail = response.status === 401 || response.status === 402 ? hint : errorMessage(body) ?? hint ?? "请求失败";
        throw new DeepSeekError(response.status, `${detail}（HTTP ${response.status}）`);
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 错误体是 OpenAI 兼容格式：{ error: { message, type, param, code } }。 */
function errorMessage(body: unknown): string | undefined {
  if (body && typeof body === "object") {
    const error = (body as { error?: { message?: unknown } }).error;
    if (error && typeof error.message === "string" && error.message.trim()) return error.message.trim().slice(0, 300);
  }
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 300);
  return undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseSearchResult(raw: unknown): DeepSeekSearchResult[] {
  if (!raw || typeof raw !== "object") return [];
  const record = raw as Record<string, unknown>;
  const url = text(record.url).trim();
  const title = text(record.title).trim();
  if (!url || !title) return [];
  const siteName = text(record.site_name).trim();
  const date = text(record.date).trim();
  return [{
    title,
    url,
    snippet: text(record.snippet),
    summary: text(record.summary),
    content: text(record.content),
    siteName: siteName || null,
    date: date || null,
    authority: finite(record.authority, -1),
    rerankScore: finite(record.rerank_score, 0),
  }];
}
