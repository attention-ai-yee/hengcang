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

  constructor(options: TushareRateLimiterOptions = {}) {
    // 环境变量钳位（Code Review M6）：空串/非数字/超界都不允许——RPM=0 会让 acquire 死循环挂起。
    this.maxRequestsPerMinute = clampInt(process.env.TUSHARE_MAX_RPM ?? options.maxRequestsPerMinute, 120, 1, 600);
    this.concurrency = clampInt(process.env.TUSHARE_CONCURRENCY ?? options.concurrency, 3, 1, 16);
    this.retries = Math.min(Math.max(options.retries ?? 2, 0), 5);
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
      if (this.active < this.concurrency && this.starts.length < this.maxRequestsPerMinute) {
        this.active += 1;
        this.starts.push(now);
        return;
      }
      const nextMinute = this.starts[0] ? Math.max(10, this.starts[0] + 60_000 - now) : 10;
      await delay(this.active >= this.concurrency ? 25 : nextMinute);
    }
  }
}

function clampInt(raw: string | number | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
