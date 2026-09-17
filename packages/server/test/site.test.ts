import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SITE = resolve(import.meta.dirname, '..', '..', '..', 'site');

describe('the marketing site is self-contained', () => {
  const html = readFileSync(join(SITE, 'index.html'), 'utf8');
  const css = readFileSync(join(SITE, 'styles.css'), 'utf8');

  it('loads nothing from another host: no scripts, no remote images, styles or fonts', () => {
    expect(html).not.toMatch(/<script\b/i);
    const loaded = [...html.matchAll(/<(?:img|link|source|video|audio|iframe)\b[^>]*?\b(?:src|href)="([^"]+)"/gi)].map((m) => m[1]);
    expect(loaded.length).toBeGreaterThan(4);
    expect(loaded.filter((u) => /^(?:https?:)?\/\//.test(u))).toEqual([]);
    expect(css).not.toMatch(/@import|url\(\s*['"]?(?:https?:)?\/\//i);
  });

  it('every local file it names exists, and every picture says what it shows', () => {
    const local = [...html.matchAll(/\b(?:src|href|content)="([^"#:]+\.(?:png|jpe?g|svg|css|webp))"/gi)].map((m) => m[1]);
    expect(local.filter((p) => !existsSync(join(SITE, p)))).toEqual([]);
    const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
    expect(imgs.filter((t) => !/\balt="/.test(t))).toEqual([]);
    expect(imgs.filter((t) => !/favicon/.test(t) && /\balt=""/.test(t))).toEqual([]);
  });

  it('respects reduced motion and both colour schemes', () => {
    expect(css).toMatch(/prefers-reduced-motion: no-preference/);
    expect(css).toMatch(/prefers-color-scheme: light/);
    expect(css.split('@media (prefers-reduced-motion')[0]).not.toMatch(/animation:/); // nothing moves outside that block
  });
});
