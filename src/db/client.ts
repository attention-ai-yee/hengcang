import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as {
  sqlite?: Database.Database;
};

function databasePath(): string {
  const configured = process.env.DATABASE_URL ?? "./data/hengcang.db";
  return path.resolve(/* turbopackIgnore: true */ process.cwd(), configured);
}

export function getDatabase() {
  if (!globalForDb.sqlite) {
    const filename = databasePath();
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    globalForDb.sqlite = new Database(filename);
    globalForDb.sqlite.pragma("journal_mode = WAL");
    globalForDb.sqlite.pragma("foreign_keys = ON");
  }

  return drizzle(globalForDb.sqlite, { schema });
}

/** 原始 SQLite 句柄（只读的自检脚本直接写 SQL 用） */
export function rawDatabase(): Database.Database {
  getDatabase();
  return globalForDb.sqlite as Database.Database;
}

export function closeDatabase() {
  globalForDb.sqlite?.close();
  globalForDb.sqlite = undefined;
}
