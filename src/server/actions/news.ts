"use server";

import { z } from "zod";
import { confirmNewsItem, dismissNewsItem, draftThesis, scanNews } from "@/server/news-watch-service";

export type NewsActionResult = { ok: true; message: string } | { ok: false; message: string };
export type DraftActionResult = { ok: true; thesis: string; breakers: string[] } | { ok: false; message: string };

/** server action 的参数来自浏览器，同样要校验 */
const idSchema = z.string().trim().min(1).max(64);

function failure(error: unknown, fallback: string): { ok: false; message: string } {
  return { ok: false, message: error instanceof Error ? error.message : fallback };
}

/** 页面「立即检查」：只扫这一个持仓，忽略每天一次的间隔（§7）。 */
export async function scanHoldingNewsAction(holdingId: string): Promise<NewsActionResult> {
  const id = idSchema.safeParse(holdingId);
  if (!id.success) return { ok: false, message: "持仓无效" };
  try {
    const report = await scanNews({ holdingId: id.data, force: true });
    if (report.status === "NOT_CONFIGURED") return { ok: false, message: "本机尚未配置 DEEPSEEK_API_KEY" };
    if (report.status === "ERROR") return { ok: false, message: report.warnings[0] ?? "检查失败" };
    const parts = [`看了 ${report.newItems} 篇新文章`];
    if (report.triggered > 0) parts.push(`自动触发 ${report.triggered} 条失效条件`);
    if (report.possible > 0) parts.push(`${report.possible} 条可能触发，等你确认`);
    if (report.warnings.length > 0) parts.push(`有 ${report.warnings.length} 个问题：${report.warnings[0]}`);
    return { ok: true, message: parts.join("；") };
  } catch (error) {
    return failure(error, "检查失败");
  }
}

export async function confirmNewsAction(newsItemId: string): Promise<NewsActionResult> {
  const id = idSchema.safeParse(newsItemId);
  if (!id.success) return { ok: false, message: "新闻无效" };
  try {
    await confirmNewsItem(id.data);
    return { ok: true, message: "已确认并触发：该持仓暂停新增" };
  } catch (error) {
    return failure(error, "确认失败");
  }
}

export async function dismissNewsAction(newsItemId: string): Promise<NewsActionResult> {
  const id = idSchema.safeParse(newsItemId);
  if (!id.success) return { ok: false, message: "新闻无效" };
  try {
    await dismissNewsItem(id.data);
    return { ok: true, message: "已处理" };
  } catch (error) {
    return failure(error, "操作失败");
  }
}

export async function draftThesisAction(holdingId: string): Promise<DraftActionResult> {
  const id = idSchema.safeParse(holdingId);
  if (!id.success) return { ok: false, message: "持仓无效" };
  try {
    return { ok: true, ...await draftThesis(id.data) };
  } catch (error) {
    return failure(error, "起草失败");
  }
}
