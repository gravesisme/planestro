/** Canonical timestamp text: `YYYY-MM-DDTHH:mm:ss±HH:mm`, local offset, second precision. */
export function isoLocal(date: Date = new Date()): string {
  const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

/** Parse any ISO 8601 string; a missing offset is treated as local time. */
export function parseTimestamp(text: string): Date {
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid timestamp: ${text}`);
  return d;
}

/** Re-serialize any accepted timestamp into canonical form (same instant). */
export function canonicalTimestamp(text: string): string {
  return isoLocal(parseTimestamp(text));
}

export function compareTimestamps(a?: string, b?: string): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return parseTimestamp(a).getTime() - parseTimestamp(b).getTime();
}
