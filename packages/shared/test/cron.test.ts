import { describe, it, expect } from 'vitest';
import { parseCron, nextSlot, prevSlot, isoInZone, validTimeZone, parseScheduleFile, serializeScheduleFile } from '../src/index.ts';

const at = (s: string) => new Date(s);

describe('cron (#247)', () => {
  it('parses the five fields, names, steps, lists and aliases; refuses the rest', () => {
    expect([...parseCron('*/15 9-17 * * MON-FRI').minute]).toEqual([0, 15, 30, 45]);
    expect([...parseCron('0 9 * * 7').dow]).toEqual([0]);
    expect([...parseCron('@weekly').dow]).toEqual([0]);
    expect([...parseCron('0 0 1 jan,jul *').month]).toEqual([1, 7]);
    for (const bad of ['', '* * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '*/0 * * * *', '5-1 * * * *', 'x * * * *', '* * * * * *']) expect(() => parseCron(bad), bad).toThrow(/cron/);
  });
  it('finds the next and previous slot in a time zone, across a DST change', () => {
    const c = parseCron('30 9 * * 1');
    expect(isoInZone(nextSlot(c, 'Europe/London', at('2026-10-08T00:00:00Z'))!, 'Europe/London')).toBe('2026-10-12T09:30:00+01:00');
    expect(isoInZone(nextSlot(c, 'Europe/London', at('2026-10-26T00:00:00Z'))!, 'Europe/London')).toBe('2026-10-26T09:30:00+00:00');
    expect(isoInZone(prevSlot(c, 'Europe/London', at('2026-10-12T08:30:00Z'))!, 'Europe/London')).toBe('2026-10-12T09:30:00+01:00');
    expect(isoInZone(prevSlot(c, 'Europe/London', at('2026-10-12T08:29:59Z'))!, 'Europe/London')).toBe('2026-10-05T09:30:00+01:00');
    // A wall time the spring-forward skips runs once, just after the jump.
    expect(isoInZone(nextSlot(parseCron('30 2 * * *'), 'America/New_York', at('2027-03-14T00:00:00Z'))!, 'America/New_York')).toBe('2027-03-14T03:30:00-04:00');
  });
  it('a restricted day of month and day of week match either, as cron has it', () => {
    const c = parseCron('0 0 13 * 5');
    expect(nextSlot(c, 'UTC', at('2026-10-08T00:00:00Z'))!.toISOString()).toBe('2026-10-09T00:00:00.000Z'); // a Friday
    expect(nextSlot(c, 'UTC', at('2026-10-09T00:00:00Z'))!.toISOString()).toBe('2026-10-13T00:00:00.000Z'); // the 13th
    expect(nextSlot(parseCron('0 0 30 2 *'), 'UTC', at('2026-10-08T00:00:00Z'))).toBeUndefined();
  });
  it('time zones are checked', () => {
    expect(validTimeZone('Europe/London')).toBe(true);
    expect(validTimeZone('Mars/Olympus')).toBe(false);
  });
  it('a schedule file round-trips, and an invalid cron or zone is refused', () => {
    const text = '---\nschema: 1\nname: weekly-audit\ntitle: Audit {{date}}\ncron: "0 9 * * 1"\ntz: UTC\ncreated_at: 2026-10-08T10:00:00+00:00\nupdated_at: 2026-10-08T10:00:00+00:00\narmed_at: 2026-10-08T10:00:00+00:00\n---\n# Description\n\nLook at {{slot}}.\n';
    const f = parseScheduleFile(text);
    expect(f.frontmatter).toMatchObject({ enabled: true, skip_if_open: false, submit: false, kind: 'item', history: [] });
    expect(parseScheduleFile(serializeScheduleFile(f))).toEqual(f);
    expect(() => parseScheduleFile(text.replace('0 9 * * 1', '0 99 * * 1'))).toThrow(/cron/);
    expect(() => parseScheduleFile(text.replace('tz: UTC', 'tz: Nowhere/Else'))).toThrow(/time zone/);
  });
});
