import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { oneAtATime } from '../src/sending.ts';

/**
 * #304: Approve breakdown (and every other action button) showed nothing until the view updated, so it was unclear
 * the press registered and it invited a second one. #282 did this for answers; every action now goes through the same
 * guard: marked busy at once, a second press sends nothing, an error unlocks it, and a success unlocks once the view
 * it changed has been refreshed (`act` refreshes before it resolves), so a button that stays on screen can be used again.
 */
describe('an action button shows at once that it is working (#304)', () => {
  it('the first press marks it busy synchronously; a second press during flight is ignored', async () => {
    const states: (string | undefined)[] = [];
    const g = oneAtATime((key) => states.push(key), { hold: false });
    let release!: (v: boolean) => void;
    let calls = 0;
    const send = () => { calls++; return new Promise<boolean>((r) => { release = r; }); };
    const first = g.run('approve', send);
    expect(g.busy()).toBe('approve');          // before anything resolves
    expect(states).toEqual(['approve']);
    expect(await g.run('request-changes', send)).toBe(false);
    expect(calls).toBe(1);
    release(true);
    expect(await first).toBe(true);
    expect(g.busy()).toBeUndefined();          // the view has refreshed: usable again
    expect(states).toEqual(['approve', undefined]);
  });

  it('an error unlocks it', async () => {
    const g = oneAtATime(() => {}, { hold: false });
    expect(await g.run('a', async () => undefined)).toBe(false);   // act() shows the error and resolves undefined
    expect(g.busy()).toBeUndefined();
    await expect(g.run('b', async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    expect(g.busy()).toBeUndefined();
    expect(await g.run('c', async () => true)).toBe(true);
  });
});

/** Every button that makes something happen goes through the guard: no click or submit handler calls the API itself. */
describe('no action button bypasses the guard (#304)', () => {
  const root = fileURLToPath(new URL('../src', import.meta.url));
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : p.endsWith('.tsx') ? [p] : []; });
  // Answers keep their card locked until it goes away (#282): those buttons use useSending directly.
  const answers = new Set(['DecisionCard.tsx', 'AwaitingPanels.tsx']);
  const reachesApi = /\bact\(|\bapi\.|\bfetch\(/;
  const guarded = /\brun\(/;
  /** The expression in `{…}` that starts at `i` (the opening brace), braces balanced. */
  const braced = (src: string, i: number) => { let depth = 0; for (let j = i; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}' && --depth === 0) return src.slice(i + 1, j); } return src.slice(i + 1); };
  /** The nearest same-file definition of `name` before `at` (its block, when its body is one), if there is one. */
  const definition = (src: string, name: string, at: number) => {
    const m = [...src.slice(0, at).matchAll(new RegExp(`(?:const|let|function)\\s+${name}\\b[^\\n]*`, 'g'))].pop();
    if (!m) return undefined;
    const open = /(?:=>|\))\s*\{\s*$/.exec(m[0]);
    return open ? m[0] + braced(src, m.index! + m[0].lastIndexOf('{')) : m[0];
  };

  it('finds no onClick/onSubmit handler that reaches the API directly or through a function in its file', () => {
    const offenders: string[] = [];
    for (const file of files(root)) {
      const name = file.split('/').pop()!;
      if (answers.has(name)) continue;
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\bon(?:Click|Submit)=\{/g)) {
        const handler = braced(src, m.index! + m[0].length - 1);
        const bare = /^\s*([A-Za-z_]\w*)\s*$/.exec(handler)?.[1];
        const defs = [...new Set([...[...handler.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)].map((c) => c[1]), ...(bare ? [bare] : [])])].map((n) => definition(src, n, m.index!) ?? '');
        // A function that goes through a `useAction` guard (`run(key, …)`) is guarded: it marks its own button.
        const viaGuard = guarded.test(handler) || defs.some((d) => guarded.test(d));
        const unguarded = defs.some((d) => reachesApi.test(d) && !guarded.test(d)) || (reachesApi.test(handler) && !viaGuard);
        if (unguarded) offenders.push(`${name}:${src.slice(0, m.index).split('\n').length} ${handler.trim().slice(0, 90)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
