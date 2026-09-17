import type { ModelDef } from './schema.ts';

/** One proposed child of an epic. `depends_on` holds indexes into the same list, not item ids: the items do not exist yet. */
export interface BreakdownChild { title: string; description: string; implementer: string; category?: string; depends_on?: number[] }

/**
 * Whether a proposed breakdown can be turned into items. Code decides this, not the planner and not
 * the user: a rejection goes straight back to the planner with the reason. Returns the first problem.
 */
export function validateBreakdown(children: unknown, models: readonly Pick<ModelDef, 'id'>[], categories: readonly string[]): string | null {
  if (!Array.isArray(children) || children.length === 0) return 'a breakdown needs at least one child';
  if (children.length > 24) return `a breakdown of ${children.length} children is too large to review; group the work into at most 24`;
  const ids = new Set(models.map((m) => m.id));
  for (const [i, c] of (children as Partial<BreakdownChild>[]).entries()) {
    const at = `child ${i} ("${String(c?.title ?? '').slice(0, 40)}")`;
    if (!c || typeof c.title !== 'string' || !c.title.trim()) return `child ${i} has no title`;
    if (typeof c.description !== 'string' || c.description.trim().length < 20) return `${at} needs a description that stands on its own: its worker sees nothing else`;
    if (typeof c.implementer !== 'string' || !ids.has(c.implementer)) return `${at} names implementer "${c.implementer}", which is not one of: ${[...ids].join(', ')}`;
    if (c.category !== undefined && !categories.includes(c.category)) return `${at} names category "${c.category}", which is not one of: ${categories.join(', ')}`;
    for (const d of c.depends_on ?? []) {
      if (!Number.isInteger(d) || d < 0 || d >= children.length) return `${at} depends on index ${d}, which is not a child of this breakdown (0–${children.length - 1})`;
      if (d === i) return `${at} depends on itself`;
    }
  }
  // cycles: depth-first over the index graph
  const state = new Array<0 | 1 | 2>(children.length).fill(0);
  const visit = (i: number): number | null => {
    if (state[i] === 1) return i;
    if (state[i] === 2) return null;
    state[i] = 1;
    for (const d of (children as BreakdownChild[])[i].depends_on ?? []) { const hit = visit(d); if (hit !== null) return hit; }
    state[i] = 2;
    return null;
  };
  for (let i = 0; i < children.length; i++) { const hit = visit(i); if (hit !== null) return `the dependencies form a cycle through child ${hit} ("${(children as BreakdownChild[])[hit].title.slice(0, 40)}")`; }
  return null;
}

/** Children in an order where every dependency comes before its dependents (input order otherwise kept). */
export function dependencyOrder(children: readonly BreakdownChild[]): number[] {
  const out: number[] = []; const done = new Set<number>();
  const visit = (i: number) => { if (done.has(i)) return; done.add(i); for (const d of children[i].depends_on ?? []) visit(d); out.push(i); };
  children.forEach((_c, i) => visit(i));
  return out;
}
