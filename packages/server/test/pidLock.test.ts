import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { takePidLock } from '../src/store/pidLock.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'pl-lock-'));

describe('a lock file one process holds (invariant 1)', () => {
  it('is created exclusively: a second taker finds the first, alive, and does not take it', () => {
    const path = join(dir(), 'lock');
    expect(takePidLock(path, { pid: 111 }, () => true)).toEqual({ ok: true });
    expect(takePidLock(path, { pid: 222 }, () => true)).toEqual({ ok: false, holder: { pid: 111 } });
    expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(111);
  });

  it('replaces a dead holder, an unreadable lock, and its own', () => {
    const path = join(dir(), 'lock');
    writeFileSync(path, JSON.stringify({ pid: 111 }));
    expect(takePidLock(path, { pid: 222 }, (p) => p !== 111)).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(222);
    writeFileSync(path, '{not json');
    expect(takePidLock(path, { pid: 333 }, () => true)).toEqual({ ok: true });
    expect(takePidLock(path, { pid: 333, again: true }, () => true)).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ pid: 333, again: true });
  });
});
