export interface TushareRateLimiterOptions {
  maxRequestsPerMinute?: number;
  concurrency?: number;
  retries?: number;
}

/** Shared, conservative limiter for all Tushare endpoints in this process. */
export class TushareRateLimiter {
  private readonly maxRequestsPerMinute: number;
  private readonly concurrency: number;
  private readonly retries: number;
  private active = 0;
  private readonly starts: number[] = [];
  private lastStart = 0;
  /** 相邻两个请求最少间隔（毫秒）= 60 秒 / 每分钟上限 */
  private readonly minIntervalMs: number;

  constructor(options: TushareRateLimiterOptions = {}) {
    // 环境变量钳位（Code Review M6）：空串/非数字/超界都不允许——RPM=0 会让 acquire 死循环挂起。
    this.maxRequestsPerMinute = clampInt(process.env.TUSHARE_MAX_RPM ?? options.maxRequestsPerMinute, 120, 1, 600);
    // 默认一次只发一个请求（2026-10-31）：顺序请求复用同一条长连接，出口 IP 按连接分配的环境
    // （云端、部分代理）里 Tushare 也只看到一个 IP；并发会开多条连接、各走一个 IP，
    // 一个 token 最多 10 个 IP，2026-10-30 就这样被锁过。受 RPM 上限约束，并发对总耗时帮助不大。
    this.concurrency = clampInt(process.env.TUSHARE_CONCURRENCY ?? options.concurrency, 1, 1, 16);
    this.retries = Math.min(Math.max(options.retries ?? 2, 0), 5);
    // 均匀发请求，不「先连发一分钟的额度再干等」：干等的几十秒里长连接会空闲超时被关掉，
    // 重连就换一个出口 IP（2026-10-31 云端全量回填实测：连发 + 干等开了 5 条连接）。
    this.minIntervalMs = 60_000 / this.maxRequestsPerMinute;
  }

  async run<T>(request: () => Promise<T>, shouldRetry: (error: unknown) => boolean): Promise<T> {
    let attempt = 0;
    while (true) {
      await this.acquire();
      let outcome: { ok: true; value: T } | { ok: false; error: unknown };
      try {
        outcome = { ok: true, value: await request() };
      } catch (error) {
        outcome = { ok: false, error };
      }
      // 先释放并发槽再做退避等待（Code Review M6）：退避期间不占用槽位。
      this.active -= 1;
      if (outcome.ok) return outcome.value;
      if (attempt >= this.retries || !shouldRetry(outcome.error)) throw outcome.error;
      await delay(250 * 2 ** attempt);
      attempt += 1;
    }
  }

  private async acquire(): Promise<void> {
    while (true) {
      const now = Date.now();
      while (this.starts.length > 0 && this.starts[0] <= now - 60_000) this.starts.shift();
      const spacingWait = this.lastStart + this.minIntervalMs - now;
      if (this.active < this.concurrency && this.starts.length < this.maxRequestsPerMinute && spacingWait <= 0) {
        this.active += 1;
        this.starts.push(now);
        this.lastStart = now;
        return;
      }
      const windowWait = this.starts.length >= this.maxRequestsPerMinute && this.starts[0] ? this.starts[0] + 60_000 - now : 0;
      await delay(this.active >= this.concurrency ? 25 : Math.max(10, spacingWait, windowWait));
    }
  }
}

/** 留空、非数字、≤ 0 都按默认值（.env.local 里留一行 TUSHARE_MAX_RPM= 不能变成每分钟 1 次）；其余钳位。 */
export function clampInt(raw: string | number | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || (typeof raw === "string" && raw.trim() === "")) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
