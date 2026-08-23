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
    this.maxRequestsPerMinute = Number(process.env.TUSHARE_MAX_RPM ?? options.maxRequestsPerMinute ?? 120);
    this.concurrency = Number(process.env.TUSHARE_CONCURRENCY ?? options.concurrency ?? 3);
    this.retries = options.retries ?? 2;
  }

  async run<T>(request: () => Promise<T>, shouldRetry: (error: unknown) => boolean): Promise<T> {
    let attempt = 0;
    while (true) {
      await this.acquire();
      try {
        return await request();
      } catch (error) {
        if (attempt >= this.retries || !shouldRetry(error)) throw error;
        await delay(250 * 2 ** attempt);
        attempt += 1;
      } finally {
        this.active -= 1;
      }
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

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
