import type { ItemFrontmatter } from '@planestro/shared';

export interface Searchable { frontmatter: ItemFrontmatter; text: string }

/** v1 search: case-insensitive substring over id, title and body text; every term must match. */
export function matches(item: Searchable, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = `${item.frontmatter.id} ${item.frontmatter.title} ${item.frontmatter.category} ${item.text}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}
