import { describe, it, expect } from 'vitest';
import { oneAtATime } from '../src/sending.ts';

/**
 * #282: an answer tapped on a phone showed nothing until the view updated, so it was tapped again. One answer goes
 * out at a time: a second tap while the first is in flight sends nothing, a sent answer keeps the card locked until
 * it goes away, and a failed one can be tried again.
 */
describe('one answer at a time (#282)', () => {
  it('a second tap while the first is in flight sends nothing', async () => {
    const states: (string | undefined)[] = [];
    const g = oneAtATime((key) => states.push(key));
    let release!: (v: boolean) => void;
    let calls = 0;
    const send = () => { calls++; return new Promise<boolean>((r) => { release = r; }); };
    const first = g.run('4 more tries', send);
    const second = g.run('Pause the Reaper', send);
    expect(calls).toBe(1);
    expect(g.busy()).toBe('4 more tries');
    expect(await second).toBe(false);
    release(true);
    expect(await first).toBe(true);
    expect(states).toEqual(['4 more tries']);   // marked at once, and not cleared after it went through
  });

  it('a sent answer keeps the card locked; a failed one can be tried again', async () => {
    const states: (string | undefined)[] = [];
    const g = oneAtATime((key) => states.push(key));
    expect(await g.run('a', async () => false)).toBe(false);   // act() returns undefined/false on an error
    expect(g.busy()).toBeUndefined();
    expect(states).toEqual(['a', undefined]);
    expect(await g.run('b', async () => true)).toBe(true);
    expect(g.busy()).toBe('b');
    expect(await g.run('c', async () => true)).toBe(false);
  });

  it('a send that throws unlocks too', async () => {
    const g = oneAtATime(() => {});
    await expect(g.run('a', async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    expect(g.busy()).toBeUndefined();
  });
});
