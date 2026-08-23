import type { ProviderResult } from "./types";

type ProviderErrorCode =
  | "NOT_CONFIGURED"
  | "NOT_SUPPORTED"
  | "PERMISSION_DENIED"
  | "RATE_LIMITED"
  | "UPSTREAM_ERROR"
  | "INVALID_RESPONSE";

export function providerFailure<T>(
  provider: string,
  code: ProviderErrorCode,
  message: string,
): ProviderResult<T> {
  return {
    ok: false,
    provider,
    fetchedAt: new Date().toISOString(),
    error: { code, message },
    fallbackAllowed: true,
  };
}

/** 非 2xx 响应：携带状态码与已解析的响应体，供调用方映射结构化错误码（Code Review M2）。 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `HTTP ${status}`);
    this.name = "HttpError";
  }

  /** 从常见错误体形态中提取可读信息 */
  get detail(): string {
    const body = this.body;
    if (typeof body === "string" && body.trim()) return body.slice(0, 300);
    if (body && typeof body === "object") {
      const record = body as Record<string, unknown>;
      for (const key of ["error_message", "message", "errmsg", "msg", "detail"]) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) return value;
      }
    }
    return this.message;
  }
}

/**
 * 把 HTTP 状态码映射为 README Provider 规则的结构化错误码：
 * 401/403 及带 api_key 字样的 400 → 权限问题；429 → 限流；其余 → 上游错误。
 */
export function httpFailure<T>(provider: string, error: HttpError): ProviderResult<never> {
  const detail = error.detail;
  const permissionLike =
    error.status === 401 ||
    error.status === 403 ||
    (error.status === 400 && /api[ _-]?key|invalid.*key|missing.*key/i.test(detail));
  const code: ProviderErrorCode = permissionLike
    ? "PERMISSION_DENIED"
    : error.status === 429
      ? "RATE_LIMITED"
      : "UPSTREAM_ERROR";
  return providerFailure(provider, code, `${detail}（HTTP ${error.status}）`);
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        try {
          body = await response.text();
        } catch {
          body = null;
        }
      }
      throw new HttpError(response.status, body);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}
