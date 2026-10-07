import { describe, it, expect } from 'vitest';
import { throttledBeat, HEARTBEAT_MS } from '../src/heartbeat.ts';

describe('client heartbeat (#224)', () => {
  it('sends on input at most once a minute, and tries again at once when nothing could take it', () => {
    let t = 0; let open = false; const sent: number[] = [];
    const beat = throttledBeat(() => { if (!open) return false; sent.push(t); return true; }, () => t);
    beat();                                   // no socket yet: not counted
    open = true; t = 1_000; beat();
    t = 30_000; beat(); t = 1_000 + HEARTBEAT_MS - 1; beat();
    t = 1_000 + HEARTBEAT_MS; beat();
    expect(sent).toEqual([1_000, 1_000 + HEARTBEAT_MS]);
  });
});
