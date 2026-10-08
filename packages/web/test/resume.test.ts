import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { guardResume, reloadOnce, RELOAD_GUARD_MS } from '../src/resume.ts';
import { CrashScreen } from '../src/components/CrashScreen.tsx';

/**
 * #280: the installed iPhone web app came back from the background to a black screen until it was force-quit. A page
 * restored from the back/forward cache reloads; a page that is visible with nothing rendered reloads itself, once in a
 * while at most, so a page that cannot render never loops; and a render error shows itself instead of a blank page.
 */
function fakes(opts: { rendered?: boolean; hidden?: boolean } = {}) {
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const timers: (() => void)[] = [];
  const store = new Map<string, string>();
  const env = {
    reloads: 0, now: 1_000_000,
    win: { addEventListener: (t: string, f: (e: any) => void) => { (listeners[t] ??= []).push(f); } },
    doc: { hidden: opts.hidden ?? false, addEventListener: (t: string, f: (e: any) => void) => { (listeners[t] ??= []).push(f); }, getElementById: () => ({ childElementCount: opts.rendered === false ? 0 : 1 }) },
    storage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } },
  };
  const deps = {
    win: env.win, doc: env.doc as any, storage: env.storage,
    reload: () => { env.reloads++; }, now: () => env.now,
    later: (f: () => void) => { timers.push(f); },
  };
  return { env, deps, fire: (t: string, e: any = {}) => (listeners[t] ?? []).forEach((f) => f(e)), runTimers: () => timers.splice(0).forEach((f) => f()) };
}

describe('coming back to the installed app (#280)', () => {
  it('a page restored from the back/forward cache reloads; an ordinary show does not', () => {
    const f = fakes(); guardResume(f.deps);
    f.fire('pageshow', { persisted: false }); expect(f.env.reloads).toBe(0);
    f.fire('pageshow', { persisted: true }); expect(f.env.reloads).toBe(1);
  });

  it('visible with nothing rendered reloads itself; a rendered page is left alone', () => {
    const blank = fakes({ rendered: false }); guardResume(blank.deps);
    blank.fire('visibilitychange'); blank.runTimers();
    expect(blank.env.reloads).toBe(1);
    const fine = fakes(); guardResume(fine.deps);
    fine.fire('visibilitychange'); fine.runTimers();
    expect(fine.env.reloads).toBe(0);
  });

  it('a page still hidden when the check runs is not reloaded', () => {
    const f = fakes({ rendered: false, hidden: true }); guardResume(f.deps);
    f.fire('visibilitychange'); f.runTimers();
    expect(f.env.reloads).toBe(0);
  });

  it('never loops: a second recovery within the guard window is refused, and allowed again after it', () => {
    const f = fakes({ rendered: false });
    expect(reloadOnce(f.deps)).toBe(true);
    expect(reloadOnce(f.deps)).toBe(false);
    f.env.now += RELOAD_GUARD_MS + 1;
    expect(reloadOnce(f.deps)).toBe(true);
    expect(f.env.reloads).toBe(2);
  });

  it('a render error shows what failed and a Reload button instead of a blank page', () => {
    const html = renderToStaticMarkup(createElement(CrashScreen, { error: new TypeError("Cannot read properties of undefined (reading 'map')") }));
    expect(html).toContain('planestro hit an error');
    expect(html).toContain("Cannot read properties of undefined (reading &#x27;map&#x27;)");
    expect(html).toMatch(/<button[^>]*>Reload<\/button>/);
  });
});
