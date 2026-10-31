import "./load-env";
import path from "node:path";
import { exportMarketSnapshot, importMarketSnapshot } from "../src/server/market-snapshot";

/**
 * 市场数据存档（src/server/market-snapshot.ts）：
 *   pnpm snapshot:export [输出文件]   默认 data/snapshots/market-data.sqlite.gz（已被 .gitignore 忽略）
 *   pnpm snapshot:import [存档文件]   导入到 DATABASE_URL（先 pnpm db:migrate 和 pnpm db:seed）
 * 存档只能放进私有仓库，绝不能提交到本仓库（公开）。
 */
const DEFAULT_FILE = "data/snapshots/market-data.sqlite.gz";
const database = path.resolve(process.env.DATABASE_URL ?? "./data/hengcang.db");
const [command, file] = process.argv.slice(2);
const target = path.resolve(file ?? DEFAULT_FILE);
if (command === "export") {
  const result = exportMarketSnapshot(database, target);
  console.log(`存档 ${target}（${(result.bytes / 1024 / 1024).toFixed(1)} MB，最新行情 ${result.latestPriceDate ?? "无"}）`);
  console.log(JSON.stringify(result.rows));
} else if (command === "import") {
  const result = importMarketSnapshot(target, database);
  console.log(`已导入 ${target} → ${database}（最新行情 ${result.latestPriceDate ?? "无"}）`);
  console.log(JSON.stringify(result.rows));
} else {
  console.error("用法：pnpm snapshot:export|snapshot:import [文件]");
  process.exitCode = 1;
}
