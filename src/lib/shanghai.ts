/**
 * 上海时区（Asia/Shanghai）的 YYYY-MM-DD 日期。
 * 表单与服务端统一用它取"今天"，避免 UTC 日期在北京时间 0–8 点差一天
 * （Code Review M14/M9）。
 */
export function shanghaiDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** 上海时区的「YYYY/MM/DD HH:mm」，用于展示记录时间（数据库存 UTC ISO）。 */
export function shanghaiDateTime(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}
