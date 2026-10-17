import { describe, it, expect } from 'vitest';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Journal, redactSecrets } from '../src/store/Journal.ts';

describe('Journal', () => {
  it('appends NDJSON per month, filters, and finds open ops', () => {
    const j = new Journal(join(mkdtempSync(join(tmpdir(), 'pj-')), 'journal'));
    const op1 = j.begin('rebasing', 'X-1', { base: 'abc' });
    const op2 = j.begin('pushing', 'X-2');
    j.end(op1, 'X-1', 'ok');
    j.append({ type: 'item.updated', item: 'X-1', actor: 'user' });
    expect(j.read({ item: 'X-1' }).map((e) => e.type)).toEqual(['op.begin', 'op.end', 'item.updated']);
    const open = j.openOps();
    expect(open).toHaveLength(1);
    expect(open[0].data).toMatchObject({ op: 'pushing', op_id: op2 });
    expect(j.read({ limit: 1 })[0].type).toBe('item.updated');
  });

  it('serves recent months from memory, reading on from where it stopped, and old months from disk', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'pj-')), 'journal');
    const j = new Journal(dir);
    const line = (ts: string, type: string, item?: string) => JSON.stringify({ ts, type, actor: 'engine', ...(item ? { item } : {}) }) + '\n';
    j.append({ ts: '2026-01-05T10:00:00Z', type: 'a', item: 'X-1', actor: 'engine' });
    writeFileSync(join(dir, '2026-02.ndjson'), line('2026-02-01T00:00:00Z', 'b', 'X-1') + line('2026-02-02T00:00:00Z', 'a'));
    writeFileSync(join(dir, '2026-03.ndjson'), line('2026-03-01T00:00:00Z', 'a', 'X-2'));
    expect(j.read({ type: 'a' }).map((e) => e.ts)).toEqual(['2026-01-05T10:00:00Z', '2026-02-02T00:00:00Z', '2026-03-01T00:00:00Z']);
    // Another writer's lines, and one still being written, are picked up once whole.
    appendFileSync(join(dir, '2026-03.ndjson'), line('2026-03-02T00:00:00Z', 'b', 'X-2') + '{"ts":"2026-03-03');
    expect(j.read({ item: 'X-2' }).map((e) => e.type)).toEqual(['a', 'b']);
    appendFileSync(join(dir, '2026-03.ndjson'), 'T00:00:00Z","type":"c","actor":"engine"}\n');
    expect(j.read({ types: ['b', 'c'] }).map((e) => e.type)).toEqual(['b', 'b', 'c']);
    expect(j.read({ types: (t) => t !== 'a', item: 'X-1' }).map((e) => e.ts)).toEqual(['2026-02-01T00:00:00Z']);
    expect(j.read({ since: '2026-03-02' }).map((e) => e.type)).toEqual(['b', 'c']);
    expect(j.read({ limit: 2 }).map((e) => e.type)).toEqual(['b', 'c']);
    expect(j.read({ type: 'a', limit: 2 }).map((e) => e.ts)).toEqual(['2026-02-02T00:00:00Z', '2026-03-01T00:00:00Z']);
    // A month before `since`, less the one month allowed for another offset, is not opened at all.
    writeFileSync(join(dir, '2026-01.ndjson'), 'not json\n');
    expect(j.read({ since: '2026-03-01' }).length).toBe(3);
    expect(j.read().length).toBe(5);
  });

  it('never writes a token-shaped string', () => {
    const j = new Journal(join(mkdtempSync(join(tmpdir(), 'pj-')), 'journal'));
    const token = 'ghp_' + 'a1B2'.repeat(9);
    const e = j.append({ type: 'tools.ran', actor: 'engine', data: { command: `gh auth login --with-token ${token}`, header: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123' } });
    expect(JSON.stringify(e)).not.toContain(token);
    expect(JSON.stringify(j.read())).not.toContain(token);
    expect(e.data).toEqual({ command: 'gh auth login --with-token [redacted]', header: 'Authorization: Bearer [redacted]' });
    expect(redactSecrets('sk-ant-api03-' + 'x'.repeat(30) + ' AKIAABCDEFGHIJKLMNOP xoxb-1234567890-abc')).toBe('[redacted] [redacted] [redacted]');
    expect(redactSecrets('task-runner sk-short ghp_short')).toBe('task-runner sk-short ghp_short');
  });
});
