import type { ProviderResult } from "./types";

export function providerFailure<T>(
  provider: string,
  code: "NOT_CONFIGURED" | "NOT_SUPPORTED" | "PERMISSION_DENIED" | "RATE_LIMITED" | "UPSTREAM_ERROR" | "INVALID_RESPONSE",
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

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}
