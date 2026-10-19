import fs from "node:fs";
import path from "node:path";

/**
 * 命令行脚本（refresh / news-scan / worker）读取 .env.local：Next.js 只为应用本身加载它。
 * 已经存在的环境变量优先，不覆盖。
 */
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
