import { describe, it, expect } from 'vitest';
import { CATEGORY_PALETTE, DARK_TEXT, LIGHT_TEXT, categoryColor, categoryColors, contrastRatio, contrastText, suggestCategoryColor } from '../src/categoryColors.ts';

describe('category colors', () => {
  it('the text on a tag contrasts with its background: dark on light fills, white on dark ones', () => {
    expect(contrastText('#ffee00')).toBe(DARK_TEXT);
    expect(contrastText('#ffffff')).toBe(DARK_TEXT);
    expect(contrastText('#8fbf4d')).toBe(DARK_TEXT);
    expect(contrastText('#8b0000')).toBe(LIGHT_TEXT);
    expect(contrastText('#1a237e')).toBe(LIGHT_TEXT);
    expect(contrastText('#000000')).toBe(LIGHT_TEXT);
  });
  it('every palette color reads with the text chosen for it', () => {
    for (const c of CATEGORY_PALETTE) expect(contrastRatio(c, contrastText(c))).toBeGreaterThanOrEqual(4.5);
  });
  it('a suggestion avoids the colors in use, then falls back to one picked by the name', () => {
    expect(suggestCategoryColor('A', [])).toBe(CATEGORY_PALETTE[0]);
    expect(suggestCategoryColor('A', [CATEGORY_PALETTE[0].toUpperCase()])).toBe(CATEGORY_PALETTE[1]);
    const full = suggestCategoryColor('Game', CATEGORY_PALETTE);
    expect(CATEGORY_PALETTE).toContain(full);
    expect(suggestCategoryColor('Game', CATEGORY_PALETTE)).toBe(full);
  });
  it('a category missing a stored color gets one the others do not use', () => {
    const colors = categoryColors({ categories: ['Game', 'Bug', 'Docs'], category_colors: { Bug: CATEGORY_PALETTE[0], Docs: 'nope' } });
    expect(colors.Bug).toBe(CATEGORY_PALETTE[0]);
    expect(new Set(Object.values(colors)).size).toBe(3);
    expect(categoryColor({ categories: ['Game'], category_colors: {} }, 'Game')).toBe(CATEGORY_PALETTE[0]);
  });
});
