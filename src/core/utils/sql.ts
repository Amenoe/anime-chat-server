/** 把统计用的天数收敛到 1–90，避免任意整数拼进 SQL 的 INTERVAL */
export function clampDays(days: unknown, fallback = 14): number {
  const n = Number(days);
  return Number.isFinite(n)
    ? Math.min(Math.max(Math.trunc(n), 1), 90)
    : fallback;
}

/** 收敛分页大小 */
export function clampLimit(limit: unknown, fallback = 20, max = 100): number {
  const n = Number(limit);
  return Number.isFinite(n)
    ? Math.min(Math.max(Math.trunc(n), 1), max)
    : fallback;
}

/**
 * 把指定列转成数字。
 *
 * 为什么不用 SQL 的 `CAST(x AS SIGNED)`：TypeORM 的 mysql 驱动开了
 * `bigNumberStrings`，COUNT/SUM 回来**仍然是字符串**（实测 CAST 无效）。
 * 与其在 SQL 里堆一堆 CAST 还不管用，不如在应用层显式声明哪些列是数值 ——
 * 顺带也把「这一列是数字」这件事写在了代码里。
 */
export function toNumbers<T extends Record<string, unknown>>(
  rows: T[],
  keys: string[],
): T[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = { ...row };
    for (const key of keys) {
      if (key in out && out[key] !== null && out[key] !== undefined) {
        out[key] = Number(out[key]);
      }
    }
    return out as T;
  });
}

/** 单行版本 */
export function rowToNumbers<T extends Record<string, unknown>>(
  row: T,
  keys: string[],
): T {
  return toNumbers([row], keys)[0];
}
