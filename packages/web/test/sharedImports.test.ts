import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// #408: the web imports shared through `@planestro/shared/view`, which keeps zod and the file codecs out of the bundle.
// The root entry is allowed only as `import type`, and at runtime only in a page that is loaded lazily.
const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');
/** Settings reads each key's default from the zod schema (`settingDefault`); zod rides in its lazy chunk. */
const LAZY_ROOT_IMPORTERS = ['pages/Settings.tsx'];

const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []);

/** Files that import the root entry with anything that survives compilation. */
function rootImporters(): string[] {
  const stmt = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s*['"]@planestro\/shared['"]/g;
  return files(SRC).filter((f) => [...readFileSync(f, 'utf8').matchAll(stmt)].some((m) => {
    if (m[2]) return false;
    const list = /^\{([^}]*)\}$/.exec(m[3].trim());
    return !(list && list[1].split(',').map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith('type ')));
  })).map((f) => relative(SRC, f)).sort();
}

describe('web imports of @planestro/shared (#408)', () => {
  it('go through /view, except the lazy pages that need a zod schema', () => {
    expect(rootImporters()).toEqual(LAZY_ROOT_IMPORTERS);
  });

  it('those pages are only ever loaded lazily', () => {
    for (const page of LAZY_ROOT_IMPORTERS) {
      const name = page.replace(/^.*\//, '').replace(/\.tsx?$/, '');
      const statics = files(SRC).filter((f) => new RegExp(`(?:^|\\n)\\s*import\\s[^;]*from\\s*['"][./]*(?:pages/)?${name}(?:\\.tsx?)?['"]`).test(readFileSync(f, 'utf8')));
      expect(statics.map((f) => relative(SRC, f))).toEqual([]);
      expect(readFileSync(join(SRC, 'main.tsx'), 'utf8')).toMatch(new RegExp(`import\\(['"]\\./${page.replace('.', '\\.')}['"]\\)`));
    }
  });
});
