import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// #408: the web's entry into shared must not reach zod, yaml, node: modules or a file codec at runtime.
const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');

/** The module specifiers a file imports or re-exports at runtime: `import type` / `export type` and all-`type` lists are erased. */
function runtimeSpecifiers(text: string): string[] {
  const out: string[] = [];
  const stmt = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(stmt)) {
    if (m[2]) continue;
    const list = /^\{([^}]*)\}$/.exec(m[3].trim());
    if (list && list[1].split(',').map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith('type '))) continue;
    out.push(m[4]);
  }
  for (const m of text.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  return out;
}

/** Every module view.ts reaches at runtime, with the path that reached it. */
function graph(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const walk = (file: string, via: string[]) => {
    if (seen.has(file)) return;
    seen.set(file, via);
    for (const spec of runtimeSpecifiers(readFileSync(file, 'utf8'))) {
      if (spec.startsWith('.')) walk(join(dirname(file), spec), [...via, relative(SRC, file)]);
      else seen.set(spec, [...via, relative(SRC, file)]);
    }
  };
  walk(join(SRC, entry), []);
  return seen;
}

const CODECS = ['schema.ts', 'frontmatter.ts', 'itemfile.ts', 'promptfile.ts', 'releasefile.ts', 'questionfile.ts', 'schedulefile.ts', 'audition.ts', 'settings.ts'];

describe('@planestro/shared/view (#408)', () => {
  it('reaches no package, node: module, zod schema or file codec at runtime', () => {
    const bad = [...graph('view.ts')].filter(([m]) => !m.startsWith('/') || CODECS.includes(relative(SRC, m)));
    expect(bad.map(([m, via]) => `${m.startsWith('/') ? relative(SRC, m) : m} via ${via.join(' → ')}`)).toEqual([]);
  });

  it('the walk sees through to zod from the root entry (so the check above means something)', () => {
    const all = [...graph('index.ts').keys()];
    expect(all).toContain('zod');
    expect(all).toContain('yaml');
  });

  it('reads type-only imports as erased', () => {
    expect(runtimeSpecifiers("import type { A } from './a.ts';\nimport { type B, type C } from './b.ts';\nexport type * from './c.ts';")).toEqual([]);
    expect(runtimeSpecifiers("import { type B, c } from './b.ts';\nexport * from './d.ts';\nimport {\n  e,\n} from 'zod';")).toEqual(['./b.ts', './d.ts', 'zod']);
  });
});
