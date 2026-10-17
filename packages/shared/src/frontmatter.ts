import YAML from 'yaml';

/** Split `---\n<yaml>\n---\n<body>`; a file without frontmatter yields {} and the whole text as body. */
export function splitFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  // An editor that saves a byte-order mark would otherwise hide the frontmatter, and the item would read as invalid.
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!m) return { data: {}, body: normalized };
  const parsed = YAML.parse(m[1]) ?? {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('frontmatter must be a mapping');
  // `key: null` (or `key:`) means unset — the same as omitting the key.
  const data: Record<string, unknown> = {};
  // `__proto__:` would replace the object's prototype on assignment: a hand-edited file is not trusted with that.
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (v !== null && k !== '__proto__') data[k] = v;
  return { data, body: m[2] };
}

/**
 * Canonical YAML: keys in `order` first, then unknown keys alphabetically; null/undefined
 * omitted; short scalar arrays in flow style; no line wrapping.
 */
export function serializeFrontmatter(data: Record<string, unknown>, order: readonly string[]): string {
  const known = order.filter((k) => data[k] !== undefined && data[k] !== null);
  const unknown = Object.keys(data).filter((k) => !order.includes(k) && data[k] !== undefined && data[k] !== null).sort();
  const ordered: Record<string, unknown> = {};
  for (const k of [...known, ...unknown]) ordered[k] = stripNulls(data[k]);
  const doc = new YAML.Document(ordered);
  YAML.visit(doc, {
    Seq(_key, node) {
      if (node.items.length <= 12 && node.items.every((i) => YAML.isScalar(i))) node.flow = true;
    },
  });
  const yaml = doc.toString({ lineWidth: 0, defaultStringType: 'PLAIN', defaultKeyType: 'PLAIN' }).trimEnd();
  return `---\n${yaml}\n---\n`;
}

function stripNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripNulls);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (x !== undefined && x !== null) out[k] = stripNulls(x);
    return out;
  }
  return v;
}
