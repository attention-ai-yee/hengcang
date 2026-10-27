import { afterEach, describe, expect, it } from "vitest";
import { DeepSeekClient, DeepSeekError } from "@/providers/deepseek";

/**
 * DeepSeek 客户端按官方文档的接口约定（api-docs.deepseek.com，2026-10-17）：
 * Search / Fetch 在 /v1/tools/ 下，对话在 /chat/completions；Bearer 鉴权；
 * 408 / 429 / 5xx 重试，401 / 402 / 其它 4xx 不重试。
 */
type Scripted = { status: number; body: unknown } | Error;

function scriptedFetch(responses: Scripted[]) {
  const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {}, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    const next = responses.shift();
    if (!next) throw new Error("没有预设的响应");
    if (next instanceof Error) throw next;
    return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return { impl, calls };
}

function client(responses: Scripted[], retries = 2) {
  const fake = scriptedFetch(responses);
  return { deepseek: new DeepSeekClient({ apiKey: "test-key", fetchImpl: fake.impl, retries, retryDelayMs: 0 }), calls: fake.calls };
}

const previousKey = process.env.DEEPSEEK_API_KEY;
const previousModel = process.env.DEEPSEEK_MODEL;
afterEach(() => {
  process.env.DEEPSEEK_API_KEY = previousKey;
  process.env.DEEPSEEK_MODEL = previousModel;
  if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  if (previousModel === undefined) delete process.env.DEEPSEEK_MODEL;
});

describe("Search", () => {
  it("POST /v1/tools/search，Bearer 鉴权；解析结果，缺字段的条目丢掉", async () => {
    const { deepseek, calls } = client([{
      status: 200,
      body: {
        results: [
          {
            rerank_score: 2.4, title: "宁德时代下调设备采购计划", url: "https://news.example.com/catl", snippet: "短摘要",
            summary: "长摘要", content: "正文", site_name: "示例新闻", site_icon: null, date: "2026-10-17T03:00:00Z", authority: 3,
          },
          { title: "没有日期和来源", url: "https://news.example.com/b", snippet: "", summary: "", content: "", site_name: null, date: null },
          { title: "", url: "https://news.example.com/no-title" },
          "不是对象",
        ],
      },
    }]);
    const results = await deepseek.search("先导智能 after:2026-09-19", { count: 10, needContent: true });
    expect(calls[0].url).toBe("https://api.deepseek.com/v1/tools/search");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(calls[0].body).toEqual({ query: "先导智能 after:2026-09-19", count: 10, need_content: true });
    expect(results).toEqual([
      {
        title: "宁德时代下调设备采购计划", url: "https://news.example.com/catl", snippet: "短摘要", summary: "长摘要", content: "正文",
        siteName: "示例新闻", date: "2026-10-17T03:00:00Z", authority: 3, rerankScore: 2.4,
      },
      {
        title: "没有日期和来源", url: "https://news.example.com/b", snippet: "", summary: "", content: "",
        siteName: null, date: null, authority: -1, rerankScore: 0,
      },
    ]);
  });

  it("没有 results 字段算格式错误", async () => {
    const { deepseek } = client([{ status: 200, body: { data: [] } }]);
    await expect(deepseek.search("x")).rejects.toThrow("缺少 results");
  });
});

describe("Fetch", () => {
  it("POST /v1/tools/fetch，只传 url，返回标题和 Markdown 正文", async () => {
    const { deepseek, calls } = client([{ status: 200, body: { title: "示例", content: "# 示例\n\n正文" } }]);
    expect(await deepseek.fetchPage("https://news.example.com/a")).toEqual({ title: "示例", content: "# 示例\n\n正文" });
    expect(calls[0].url).toBe("https://api.deepseek.com/v1/tools/fetch");
    expect(calls[0].body).toEqual({ url: "https://news.example.com/a" });
  });
});

describe("Chat（JSON 输出）", () => {
  it("默认模型 deepseek-flash，response_format=json_object，默认关闭思考；解析 JSON", async () => {
    const { deepseek, calls } = client([{ status: 200, body: { choices: [{ message: { content: "{\"queries\":[\"先导智能\"]}" }, finish_reason: "stop" }] } }]);
    expect(await deepseek.chatJson([{ role: "user", content: "只输出 JSON" }])).toEqual({ queries: ["先导智能"] });
    expect(calls[0].url).toBe("https://api.deepseek.com/chat/completions");
    expect(calls[0].body).toMatchObject({ model: "deepseek-flash", response_format: { type: "json_object" }, stream: false, thinking: { type: "disabled" } });
    expect(calls[0].body).not.toHaveProperty("reasoning_effort");
  });

  it("复核时开低强度思考（reasoning_effort=low，不再显式关闭思考）", async () => {
    const { deepseek, calls } = client([{ status: 200, body: { choices: [{ message: { content: "{}", reasoning_content: "思考过程" }, finish_reason: "stop" }] } }]);
    expect(await deepseek.chatJson([], { thinking: true })).toEqual({});
    expect(calls[0].body).toMatchObject({ reasoning_effort: "low" });
    expect(calls[0].body).not.toHaveProperty("thinking");
  });

  it("官方说 JSON 输出偶尔返回空内容：空内容重试一次，两次都空才报错", async () => {
    const empty = { status: 200, body: { choices: [{ message: { content: "" }, finish_reason: "stop" }] } };
    const ok = { status: 200, body: { choices: [{ message: { content: "{\"a\":1}" }, finish_reason: "stop" }] } };
    const recovered = client([empty, ok]);
    expect(await recovered.deepseek.chatJson([])).toEqual({ a: 1 });
    expect(recovered.calls).toHaveLength(2);
    const failing = client([empty, empty]);
    await expect(failing.deepseek.chatJson([])).rejects.toThrow("没有返回内容");
    expect(failing.calls).toHaveLength(2);
  });

  it("被截断、空内容、不是 JSON 都报错", async () => {
    await expect(client([{ status: 200, body: { choices: [{ message: { content: "{\"a\":" }, finish_reason: "length" }] } }]).deepseek.chatJson([])).rejects.toThrow("截断");
    await expect(client([{ status: 200, body: { choices: [{ message: { content: "" } }] } }, { status: 200, body: { choices: [{ message: { content: "" } }] } }]).deepseek.chatJson([])).rejects.toThrow("没有返回内容");
    await expect(client([{ status: 200, body: { choices: [{ message: { content: "不是 JSON" } }] } }]).deepseek.chatJson([])).rejects.toThrow("不是有效 JSON");
  });
});

describe("错误与重试", () => {
  it("401 不重试，也不回显服务端原文", async () => {
    const { deepseek, calls } = client([{ status: 401, body: { error: { message: "Authentication Fails, your key sk-abc123 is invalid" } } }]);
    const error = await deepseek.search("x").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DeepSeekError);
    expect((error as DeepSeekError).status).toBe(401);
    expect((error as DeepSeekError).message).toBe("DeepSeek API Key 无效或缺失（HTTP 401）");
    expect((error as DeepSeekError).message).not.toContain("sk-abc123");
    expect(calls).toHaveLength(1);
  });

  it("402 余额不足、400 参数错误不重试；400 带上服务端的说明", async () => {
    const insufficient = client([{ status: 402, body: { error: { message: "Insufficient Balance" } } }]);
    await expect(insufficient.deepseek.search("x")).rejects.toThrow("余额不足");
    expect(insufficient.calls).toHaveLength(1);
    const invalid = client([{ status: 400, body: { error: { message: "'count' must be between 1 and 50", type: "invalid_request_error", param: null, code: "invalid_request_error" } } }]);
    await expect(invalid.deepseek.search("x")).rejects.toThrow("'count' must be between 1 and 50（HTTP 400）");
    expect(invalid.calls).toHaveLength(1);
  });

  it("429、5xx、网络错误按文档重试", async () => {
    const recovered = client([{ status: 429, body: { error: { message: "rate limited" } } }, new Error("socket hang up"), { status: 200, body: { results: [] } }]);
    expect(await recovered.deepseek.search("x")).toEqual([]);
    expect(recovered.calls).toHaveLength(3);
    const failing = client([{ status: 500, body: "" }, { status: 502, body: "" }, { status: 503, body: "" }], 2);
    const error = await failing.deepseek.search("x").catch((caught: unknown) => caught);
    expect((error as DeepSeekError).status).toBe(503);
    expect(failing.calls).toHaveLength(3);
  });
});

describe("fromEnv", () => {
  it("没配置 Key 返回 null；配置了就用 DEEPSEEK_MODEL（默认 deepseek-flash）", () => {
    delete process.env.DEEPSEEK_API_KEY;
    expect(DeepSeekClient.fromEnv()).toBeNull();
    process.env.DEEPSEEK_API_KEY = "  ";
    expect(DeepSeekClient.fromEnv()).toBeNull();
    process.env.DEEPSEEK_API_KEY = "key";
    delete process.env.DEEPSEEK_MODEL;
    expect(DeepSeekClient.fromEnv()?.model).toBe("deepseek-flash");
    process.env.DEEPSEEK_MODEL = "deepseek-v4-pro";
    expect(DeepSeekClient.fromEnv()?.model).toBe("deepseek-v4-pro");
  });
});
