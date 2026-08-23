import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const localEnvPath = path.resolve(".env.local");
if (fs.existsSync(localEnvPath)) {
  for (const line of fs.readFileSync(localEnvPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export async function runRefresh() {
  const { refreshAutomaticMarketData } = await import("../src/server/automatic-data-refresh-service");
  return refreshAutomaticMarketData();
}

/** 仅在直接执行本脚本时设置退出码；被 worker 导入时不得污染宿主进程（Code Review M5）。 */
const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedDirectly) {
  const report = await runRefresh();
  console.log(JSON.stringify({
    provider: report.provider,
    status: report.status,
    inserted: report.inserted,
    updated: report.updated,
    buckets: report.buckets.map((bucket) => ({
      bucket: bucket.bucket,
      observations: bucket.observationCount,
      asOf: bucket.latestAsOf,
      scoreSaved: bucket.scoreSaved,
      warnings: bucket.warnings,
    })),
  }, null, 2));
  if (report.status === "ERROR" || report.status === "NOT_CONFIGURED") process.exitCode = 1;
}
