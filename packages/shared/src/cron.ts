/**
 * Standard five-field cron (`minute hour day-of-month month day-of-week`) in an IANA time zone,
 * for schedules (#247). Fields take `*`, numbers, `a-b`, `/step`, lists, month and day names, and
 * day 7 for Sunday; `@hourly` … `@yearly` are aliases. A restricted day of month and day of week
 * match either, as cron has it. Wall times are walked in the zone and turned into instants with
 * Intl, so a slot follows the zone's clock across DST: a wall time the spring-forward skips runs
 * once just after the jump, and one the fall-back repeats maps to one instant.
 */
export interface Cron { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domStar: boolean; dowStar: boolean }

const ALIASES: Record<string, string> = { '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *' };
const NAMES: Record<number, string[]> = { 3: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'], 4: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] };
const BOUNDS: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const LABEL = ['minute', 'hour', 'day of month', 'month', 'day of week'];

function field(text: string, i: number): Set<number> {
  const [lo, hi] = BOUNDS[i];
  const num = (s: string): number => {
    const named = NAMES[i]?.indexOf(s.toLowerCase()) ?? -1;
    const n = named >= 0 ? named + (i === 3 ? 1 : 0) : /^\d+$/.test(s) ? Number(s) : NaN;
    if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`cron: ${LABEL[i]} "${s}" is not ${lo}–${hi}`);
    return n;
  };
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const m = /^([^/]+)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`cron: ${LABEL[i]} "${part}" is not a value, range or step`);
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1) throw new Error(`cron: ${LABEL[i]} step must be at least 1`);
    let a: number; let b: number;
    if (m[1] === '*') { a = lo; b = hi; } else if (m[1].includes('-')) { const [x, y, ...rest] = m[1].split('-'); if (rest.length) throw new Error(`cron: ${LABEL[i]} "${part}"`); a = num(x); b = num(y); } else { a = num(m[1]); b = m[2] === undefined ? a : hi; }
    if (a > b) throw new Error(`cron: ${LABEL[i]} range "${part}" runs backwards`);
    for (let v = a; v <= b; v += step) out.add(i === 4 && v === 7 ? 0 : v);
  }
  return new Set([...out].sort((x, y) => x - y));
}

/** Throws `cron: …` saying what is wrong. */
export function parseCron(expr: string): Cron {
  const text = ALIASES[expr.trim().toLowerCase()] ?? expr.trim();
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length !== 5) throw new Error(`cron: "${expr}" needs five fields (minute hour day-of-month month day-of-week)`);
  const [minute, hour, dom, month, dow] = parts.map(field);
  return { minute, hour, dom, month, dow, domStar: parts[2] === '*', dowStar: parts[4] === '*' };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }); formatters.set(tz, f); }
  return f;
}
export function validTimeZone(tz: string): boolean { try { formatter(tz); return true; } catch { return false; } }

/** The zone's wall clock at instant `t`, as a UTC millisecond count (seconds kept). */
function toWall(t: number, tz: string): number {
  const p: Record<string, number> = {};
  for (const x of formatter(tz).formatToParts(new Date(t))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}
const floorSec = (t: number) => Math.floor(t / 1000) * 1000;
const offsetAt = (t: number, tz: string) => toWall(t, tz) - floorSec(t);
/** The instant the zone's clock reads wall time `w`; in a spring-forward gap, the instant after the jump. */
function fromWall(w: number, tz: string): number {
  const t1 = w - offsetAt(w, tz); const t2 = w - offsetAt(t1, tz);
  return toWall(t2, tz) === w ? t2 : Math.max(t1, t2);
}

function dayMatches(c: Cron, w: Date): boolean {
  const dom = c.dom.has(w.getUTCDate()); const dow = c.dow.has(w.getUTCDay());
  return c.domStar || c.dowStar ? dom && dow : dom || dow;
}
const SPAN = 5 * 366 * 86_400_000;

/** The first slot strictly after `after`; undefined when none falls within five years (`0 0 30 2 *`). */
export function nextSlot(c: Cron, tz: string, after: Date): Date | undefined {
  const start = toWall(after.getTime(), tz);
  for (let w = Math.floor(start / 60_000) * 60_000 + 60_000; w < start + SPAN;) {
    const d = new Date(w); const y = d.getUTCFullYear(); const mo = d.getUTCMonth(); const day = d.getUTCDate(); const h = d.getUTCHours();
    if (!c.month.has(mo + 1)) { w = Date.UTC(y, mo + 1, 1); continue; }
    if (!dayMatches(c, d)) { w = Date.UTC(y, mo, day + 1); continue; }
    if (!c.hour.has(h)) { w = Date.UTC(y, mo, day, h + 1); continue; }
    if (!c.minute.has(d.getUTCMinutes())) { w += 60_000; continue; }
    const t = fromWall(w, tz);
    if (t > after.getTime()) return new Date(t);
    w += 60_000;
  }
  return undefined;
}

/** The last slot at or before `at`; undefined when none falls within five years. */
export function prevSlot(c: Cron, tz: string, at: Date): Date | undefined {
  const start = toWall(at.getTime(), tz);
  for (let w = Math.floor(start / 60_000) * 60_000 + 60_000; w > start - SPAN;) {
    w -= 60_000;
    const d = new Date(w); const y = d.getUTCFullYear(); const mo = d.getUTCMonth(); const day = d.getUTCDate(); const h = d.getUTCHours();
    if (!c.month.has(mo + 1)) { w = Date.UTC(y, mo, 1); continue; }
    if (!dayMatches(c, d)) { w = Date.UTC(y, mo, day); continue; }
    if (!c.hour.has(h)) { w = Date.UTC(y, mo, day, h); continue; }
    if (!c.minute.has(d.getUTCMinutes())) continue;
    const t = fromWall(w, tz);
    if (t <= at.getTime()) return new Date(t);
  }
  return undefined;
}

/** `2026-10-12T09:30:00+01:00`: the instant on the zone's clock, with its offset. */
export function isoInZone(t: Date, tz: string): string {
  const off = Math.round(offsetAt(t.getTime(), tz) / 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const sign = off < 0 ? '-' : '+'; const abs = Math.abs(off);
  return `${new Date(toWall(t.getTime(), tz)).toISOString().slice(0, 19)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
