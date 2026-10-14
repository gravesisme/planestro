import type { Config } from './schema.ts';

// ---- category colors: a background per category (category_colors), and the text drawn on it ----

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Suggested in order, so the first categories of a project differ as much as possible; all read on the dark board. */
export const CATEGORY_PALETTE = [
  '#3987e5', '#d95926', '#199e70', '#e6b422', '#d55181', '#9085e9',
  '#e66767', '#4fb8c9', '#8fbf4d', '#7b3fa0', '#c9a2ff', '#a33a3a',
];

/** Dark text on a light fill (the app's on-fill dark, as `.chip.on`) or white on a dark one. */
export const DARK_TEXT = '#0b0d10';
export const LIGHT_TEXT = '#ffffff';

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0;
  return h;
}

/** The first palette color no other category has; once every one is taken, one picked by the name, the same every time. */
export function suggestCategoryColor(name: string, used: Iterable<string>): string {
  const taken = new Set([...used].map((c) => c.toLowerCase()));
  return CATEGORY_PALETTE.find((c) => !taken.has(c)) ?? CATEGORY_PALETTE[hash(name) % CATEGORY_PALETTE.length];
}

/** Every category in list order, each with its stored color or, missing one (a hand-edited file), a suggestion that avoids the others. */
export function categoryColors(config: Pick<Config, 'categories'> & { category_colors?: Record<string, string> }): Record<string, string> {
  const stored = config.category_colors ?? {};
  const out: Record<string, string> = {};
  const used = new Set(Object.values(stored).map((c) => c.toLowerCase()));
  for (const c of config.categories ?? []) {
    const color = stored[c] && HEX_COLOR.test(stored[c]) ? stored[c] : suggestCategoryColor(c, used);
    out[c] = color; used.add(color.toLowerCase());
  }
  return out;
}

export function categoryColor(config: Pick<Config, 'categories'> & { category_colors?: Record<string, string> }, name: string): string {
  return categoryColors(config)[name] ?? CATEGORY_PALETTE[hash(name) % CATEGORY_PALETTE.length];
}

/** WCAG 2 relative luminance of a `#rrggbb` color. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The text color for a label on `background`: whichever of dark and white contrasts with it more. */
export function contrastText(background: string): string {
  if (!HEX_COLOR.test(background)) return LIGHT_TEXT;
  return contrastRatio(background, DARK_TEXT) >= contrastRatio(background, LIGHT_TEXT) ? DARK_TEXT : LIGHT_TEXT;
}
