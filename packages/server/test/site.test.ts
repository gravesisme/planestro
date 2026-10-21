import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const SITE = resolve(import.meta.dirname, '..', '..', '..', 'site');
const ORIGIN = 'https://planestro.com';
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}
const pages = files(SITE).filter((p) => p.endsWith('.html'));
const read = (path: string) => readFileSync(path, 'utf8');
const decode = (text: string) => text.replace(/&(amp|lt|gt|quot|apos|#x27|#39|nbsp);/g, (_, entity: string) => ({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#x27': "'", '#39': "'", nbsp: '\u00a0',
}[entity]!));
const tags = (html: string, name: string) => [...html.matchAll(new RegExp(`<${name}\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, 'gi'))].map((m) => m[0]);
const attr = (tag: string, name: string) => {
  const match = tag.match(new RegExp(`(?:^|\\s)${name}=(?:"([^"]*)"|'([^']*)')`, 'i'));
  return match ? decode(match[1] ?? match[2]) : undefined;
};
const route = (path: string) => '/' + relative(SITE, path).replace(/index\.html$/, '');
const localPath = (url: URL) => join(SITE, decodeURIComponent(url.pathname), url.pathname.endsWith('/') ? 'index.html' : '');
const mainText = (html: string) => decode(html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)![1]
  .replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

describe('the static marketing site', () => {
  it('provides all four directory routes', () => {
    expect(pages.map(route).sort()).toEqual(['/', '/blog/', '/blog/building-an-ai-fleet/', '/quick-start/']);
  });

  for (const path of pages) describe(route(path), () => {
    const html = read(path);
    it('loads only local assets, including scripts and dialog images', () => {
      const resources = tags(html, '(?:img|script|source|video|audio|iframe)').flatMap((t) => [attr(t, 'src'), attr(t, 'poster')]);
      resources.push(...tags(html, 'link').filter((t) => attr(t, 'rel') !== 'canonical').map((t) => attr(t, 'href')));
      resources.push(...tags(html, 'button').map((t) => attr(t, 'data-image')));
      expect(resources.filter(Boolean).length).toBeGreaterThan(2);
      for (const value of resources.filter((x): x is string => !!x)) {
        expect(value, `${route(path)}: ${value}`).not.toMatch(/^(?:[a-z]+:|\/\/)/i);
        expect(existsSync(localPath(new URL(value, ORIGIN + route(path))))).toBe(true);
      }
      expect(html).not.toMatch(/\bon[a-z]+\s*=/i);
    });

    it('resolves every internal link and fragment, with unique target ids', () => {
      const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
      expect(new Set(ids).size).toBe(ids.length);
      for (const tag of tags(html, 'a')) {
        const href = attr(tag, 'href');
        expect(href).toBeTruthy();
        const url = new URL(href!, ORIGIN + route(path));
        if (url.origin !== ORIGIN) continue;
        expect(existsSync(localPath(url)), href).toBe(true);
        if (url.hash) expect(read(localPath(url)), href).toContain(`id="${decodeURIComponent(url.hash.slice(1))}"`);
      }
    });

    it('has descriptive images and a keyboard-accessible site shell', () => {
      for (const image of tags(html, 'img')) {
        const alt = attr(image, 'alt');
        expect(alt).toBeDefined();
        if (!alt) expect(attr(image, 'src')?.endsWith('planestro-icon.png') || attr(image, 'id') === 'dialog-image').toBe(true);
      }
      expect(tags(html, 'h1')).toHaveLength(1);
      expect(attr(tags(html, 'a').find((t) => attr(t, 'class') === 'skip-link')!, 'href')).toBe('#top');
      expect(html).toContain('aria-label="Main"');
      expect(html).toContain('href="/quick-start/"');
      expect(html).toContain('href="/blog/"');
    });

    it('has production canonical and social metadata backed by a local image', () => {
      const canonical = tags(html, 'link').find((t) => attr(t, 'rel') === 'canonical');
      expect(attr(canonical!, 'href')).toBe(ORIGIN + route(path));
      const meta = (property: string) => attr(tags(html, 'meta').find((t) => attr(t, 'property') === property)!, 'content');
      expect(meta('og:url')).toBe(ORIGIN + route(path));
      expect(meta('og:title')).toBeTruthy();
      expect(meta('og:description')).toBeTruthy();
      const image = new URL(meta('og:image')!);
      expect(image.origin).toBe(ORIGIN);
      expect(existsSync(localPath(image))).toBe(true);
      expect(canonical).not.toMatch(/chatgpt\.com|\.oaiusercontent\.com/);
    });
  });

  it('keeps styles and scripts self-contained and respects reduced motion', () => {
    for (const path of files(SITE).filter((p) => /\.(css|js)$/.test(p))) {
      const source = read(path);
      expect(source).not.toMatch(/@import|url\(\s*['"]?(?:https?:)?\/\//i);
      expect(source).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/);
    }
    expect(read(join(SITE, 'styles.css'))).toMatch(/color-scheme:\s*light/);
    expect(read(join(SITE, 'styles.css'))).toMatch(/prefers-reduced-motion:\s*reduce/);
  });

  it('preserves the approved article text, including captions, metrics and caveats', () => {
    const text = mainText(read(join(SITE, 'blog/building-an-ai-fleet/index.html')));
    const approved = read(join(import.meta.dirname, 'fixtures/blog-content.sha256')).trim();
    expect(createHash('sha256').update(text).digest('hex')).toBe(approved);
  });

  it('keeps the nine captures, branching workflow and evidence accessible at the nested route', () => {
    const html = read(join(SITE, 'blog/building-an-ai-fleet/index.html'));
    expect(tags(html, 'button').filter((t) => attr(t, 'class') === 'capture-tab')).toHaveLength(9);
    for (const tag of tags(html, 'button').filter((t) => attr(t, 'role') === 'tab')) {
      expect(html).toContain(`id="${attr(tag, 'aria-controls')}"`);
    }
    expect(tags(html, 'details').length).toBeGreaterThan(5);
    expect(html).toContain('id="epic-workflow-title"');
    expect(html).toContain('id="inside-planestro"');
    expect(html).not.toContain('data-stage=');
    expect(html).toContain('aria-describedby="dialog-caption"');
    expect(html).toContain('href="https://hurricaneharrison.com/"');
  });

  it('keeps planned posts unlinked and setup local without a Planestro login', () => {
    const blog = read(join(SITE, 'blog/index.html'));
    expect(blog.match(/class="planned-label"/g)).toHaveLength(2);
    expect(tags(blog, 'a').map((t) => attr(t, 'href')).filter((href) => href?.startsWith('/blog/')))
      .toEqual(expect.arrayContaining(['/blog/', '/blog/building-an-ai-fleet/']));
    expect(blog.match(/<section class="planned-section"[\s\S]*?<\/section>/)![0]).not.toContain('<a ');
    const guide = mainText(read(join(SITE, 'quick-start/index.html')));
    expect(guide).toContain('private repository');
    expect(guide).toContain('There is no Planestro account or login.');
    expect(guide).toContain('complete Claude Code’s sign-in');
    expect(guide).not.toMatch(/API[- ]keys?/i);
    expect(mainText(read(join(SITE, 'index.html')))).not.toContain('Claude API access');
    expect(guide).toContain('Codex-only');
    expect(guide).toContain('npm run sample');
    expect(guide).toContain('git clone --branch main https://github.com/gravesisme/planestro');
    expect(guide).toContain('gh repo create myproject --private');
    expect(guide).toContain('on: [push, pull_request]');
    expect(guide).toContain('engine.mode');
  });
});
