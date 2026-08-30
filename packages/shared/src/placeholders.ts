/**
 * Strict template rendering: `{{a.b.c}}` looks up a dotted path in the context,
 * `{{> name}}` includes a partial (rendered with the same context). Any
 * unresolved placeholder is an error — a template is never sent half-filled.
 */
export class RenderError extends Error {
  constructor(public readonly missing: string[], public readonly template: string) {
    super(`unresolved placeholders in ${template}: ${missing.join(', ')}`);
  }
}

export type Partials = (name: string) => string | undefined;

const TOKEN = /\{\{\s*(>\s*([a-z0-9][a-z0-9-]*)|([a-zA-Z_][\w.]*))\s*\}\}/g;

export function renderPrompt(body: string, ctx: Record<string, unknown>, partials: Partials = () => undefined, name = '(inline)', depth = 0): string {
  if (depth > 8) throw new Error(`partial include depth exceeded in ${name}`);
  const missing: string[] = [];
  const out = body.replace(TOKEN, (_m, _all, partial: string | undefined, path: string | undefined) => {
    if (partial) {
      const p = partials(partial);
      if (p === undefined) { missing.push(`> ${partial}`); return ''; }
      return renderPrompt(p, ctx, partials, partial, depth + 1);
    }
    const v = lookup(ctx, path!);
    if (v === undefined || v === null) { missing.push(path!); return ''; }
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
  if (missing.length) throw new RenderError([...new Set(missing)], name);
  return out;
}

/** Placeholders referenced by a template body (dotted paths, partials as `> name`). */
export function placeholdersIn(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(TOKEN)) out.add(m[2] ? `> ${m[2]}` : m[3]);
  return [...out];
}

function lookup(ctx: Record<string, unknown>, path: string): unknown {
  let cur: unknown = ctx;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
