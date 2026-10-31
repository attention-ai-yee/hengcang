import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

/**
 * 市场数据存档（2026-10-31）：行情、估值、财报汇总、指数成分权重、数据源状态、评分存成一个压缩的 SQLite 文件，
 * 新环境导入后只做增量刷新，不用再全量回填（云端会话的数据库是临时的）。
 * 只存市场数据：持仓、组合设置、投资逻辑、新闻、决策日志、回测和手工录入的数值都不进存档。
 * 存档里是 Tushare 的数据，只能放在私有仓库（本仓库是公开的，见 docs/cloud-verification.md）。
 */
export const MARKET_TABLES = ["metric_observations", "index_constituent_snapshots", "data_source_status", "config_snapshots", "score_snapshots"];
function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function tableCounts(database: Database.Database, schema = "main"): Record<string, number> {
  return Object.fromEntries(MARKET_TABLES.map((table) => [table, (database.prepare(`select count(*) n from ${schema}.${quote(table)}`).get() as { n: number }).n]));
}

export function exportMarketSnapshot(sourceDatabase: string, output: string): { latestPriceDate: string | null; rows: Record<string, number>; bytes: number } {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "hengcang-snapshot-"));
  const copy = path.join(temporary, "snapshot.db");
  try {
    const source = new Database(sourceDatabase, { fileMustExist: true });
    source.prepare("VACUUM INTO ?").run(copy);
    source.close();
    const snapshot = new Database(copy);
    snapshot.pragma("foreign_keys = OFF");
    const tables = (snapshot.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name <> '__drizzle_migrations'").all() as Array<{ name: string }>).map((row) => row.name);
    for (const table of tables) if (!MARKET_TABLES.includes(table)) snapshot.exec(`delete from ${quote(table)}`);
    snapshot.exec("delete from metric_observations where provider = 'manual' or is_manual_override = 1");
    const latestPrice = (snapshot.prepare("select max(as_of) d from metric_observations where metric_key = 'PRICE_CLOSE'").get() as { d: string | null }).d;
    const counts = tableCounts(snapshot);
    snapshot.exec("VACUUM");
    snapshot.close();
    const compressed = zlib.gzipSync(fs.readFileSync(copy), { level: 9 });
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, compressed);
    const manifest = {
      createdAt: new Date().toISOString(),
      latestPriceDate: latestPrice,
      rows: counts,
      bytes: compressed.length,
      sha256: crypto.createHash("sha256").update(compressed).digest("hex"),
    };
    fs.writeFileSync(`${output}.json`, `${JSON.stringify(manifest, null, 2)}\n`);
    return { latestPriceDate: latestPrice, rows: counts, bytes: compressed.length };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

export function importMarketSnapshot(input: string, targetDatabase: string, migrationsFolder = path.resolve("drizzle")): { latestPriceDate: string | null; rows: Record<string, number> } {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "hengcang-snapshot-"));
  const copy = path.join(temporary, "snapshot.db");
  try {
    fs.writeFileSync(copy, zlib.gunzipSync(fs.readFileSync(input)));
    // 存档可能是旧版本的表结构：先在副本上跑一遍迁移，再按两边都有的列复制
    const snapshot = new Database(copy);
    migrate(drizzle(snapshot), { migrationsFolder });
    snapshot.close();
    const target = new Database(targetDatabase, { fileMustExist: true });
    target.pragma("foreign_keys = ON");
    if (!target.prepare("select 1 from portfolios where id = 'default'").get()) {
      throw new Error("目标库没有默认组合：先运行 pnpm db:migrate 和 pnpm db:seed");
    }
    target.prepare("ATTACH DATABASE ? AS snap").run(copy);
    const columns = (schema: string, table: string) => (target.prepare(`select name from pragma_table_info(?, ?)`).all(table, schema) as Array<{ name: string }>).map((row) => row.name);
    target.transaction(() => {
      for (const table of MARKET_TABLES) {
        const shared = columns("main", table).filter((name) => columns("snap", table).includes(name)).map(quote).join(", ");
        target.exec(`insert or replace into main.${quote(table)} (${shared}) select ${shared} from snap.${quote(table)}`);
      }
    })();
    const counts = tableCounts(target, "snap");
    target.exec("DETACH DATABASE snap");
    const latestPrice = (target.prepare("select max(as_of) d from metric_observations where metric_key = 'PRICE_CLOSE'").get() as { d: string | null }).d;
    target.close();
    return { latestPriceDate: latestPrice, rows: counts };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

