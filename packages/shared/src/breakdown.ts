import { canPlan, type ModelDef } from './schema.ts';
import { atxHeading, isTableSeparator } from './textScan.ts';

/** What a breakdown needs to know of a model: its id, and whether it can plan. */
type ModelRef = Pick<ModelDef, 'id'> & Partial<Pick<ModelDef, 'runner' | 'external' | 'codex_transport'>>;
const plans = (m: ModelRef) => canPlan({ runner: m.runner ?? 'claude', external: m.external ?? false, codex_transport: m.codex_transport });

/** One proposed child of an epic. `depends_on` holds indexes into the same list, not item ids: the items do not exist yet. */
export interface BreakdownChild {
  title: string; description: string; implementer: string; category?: string; depends_on?: number[];
  /** Who plans the child; omitted, the epic's own planner does. Must be a model that can plan. */
  planner?: string;
  /** The child's pull request waits for the user's review before it merges (review_hold). */
  hold_for_review?: boolean;
}

/**
 * Whether a proposed breakdown can be turned into items. Code decides this, not the planner and not
 * the user: a rejection goes straight back to the planner with the reason. Returns the first problem.
 */
export function validateBreakdown(children: unknown, models: readonly ModelRef[], categories: readonly string[]): string | null {
  if (!Array.isArray(children) || children.length === 0) return 'a breakdown needs at least one child';
  if (children.length > 24) return `a breakdown of ${children.length} children is too large to review; group the work into at most 24`;
  const ids = new Set(models.map((m) => m.id));
  for (const [i, c] of (children as Partial<BreakdownChild>[]).entries()) {
    const at = `child ${i} ("${String(c?.title ?? '').slice(0, 40)}")`;
    if (!c || typeof c.title !== 'string' || !c.title.trim()) return `child ${i} has no title`;
    if (typeof c.description !== 'string' || c.description.trim().length < 20) return `${at} needs a description that stands on its own: its worker sees nothing else`;
    if (typeof c.implementer !== 'string' || !ids.has(c.implementer)) return `${at} names implementer "${c.implementer}", which is not one of: ${[...ids].join(', ')}`;
    if (c.planner !== undefined) {
      const p = models.find((m) => m.id === c.planner);
      if (!p || !plans(p)) return `${at} names planner "${c.planner}", which is not a model that can plan: ${models.filter(plans).map((m) => m.id).join(', ')}`;
    }
    if (c.hold_for_review !== undefined && typeof c.hold_for_review !== 'boolean') return `${at} has hold_for_review ${JSON.stringify(c.hold_for_review)}; it is true or false`;
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

// ---- a plan on a plain item that is really an epic's breakdown (#69, HH-198) ----

/** A child the planner of a plain item proposed: carried to the epic planner as a starting point, never created from. */
export interface ProposedChild { title: string; description?: string; implementer?: string; depends_on?: number[] }

/**
 * Why this plain item's plan must not be approved as one item: `breakdown` when its planner handed in
 * children with submit_breakdown (the structural signal), `plan` when the plan's text lays out child
 * items. Kept in `op_data.looks_like_epic` until the next plan replaces it.
 */
export interface EpicFlag { reason: string; source: 'breakdown' | 'plan'; children?: ProposedChild[] }

export function epicFlagOf(fm: { kind?: string; op_data?: Record<string, unknown> }): EpicFlag | undefined {
  const f = fm.op_data?.looks_like_epic as EpicFlag | undefined;
  return fm.kind !== 'epic' && f && typeof f.reason === 'string' ? f : undefined;
}

/** A heading that names the child items themselves ("Children", "Child items", "Proposed sub-items", "Epic breakdown"), not one that merely mentions a child. */
const CHILD_HEADING = /^(?:\d+[.)]\s*)?(?:(?:the|proposed|suggested)\s+)?(?:children|child\s+(?:items|issues|tickets|tasks)|sub-?items|epic\s+breakdown|breakdown\s+into\s+(?:child\s+)?items)\b/i;
/** A table column that holds child items. */
const CHILD_COLUMN = /^(?:#\s*)?(?:child|children|child\s+item|sub-?item)s?$/i;
const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.replace(/[*_`]/g, '').trim());
const isSeparator = isTableSeparator;
const plain = (s: string) => s.replace(/[*_`]/g, '').trim();

/**
 * Whether a plan handed in for a plain item reads as an epic's breakdown, and why; null when it does
 * not. Code decides this, not a model (invariant 4). HH-198 and HH-199 were approved as items though
 * their plans were whole breakdowns with Codex art children, and went to one implementer each. The
 * check is narrow on purpose: a section headed as the children listing at least two, or a table with
 * a child column and at least two rows. A plan that merely has steps is one item.
 */
export function epicShapeOf(plan: string): string | null {
  const lines = plan.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const h = atxHeading(lines[i]);
    if (h && CHILD_HEADING.test(plain(h.text))) {
      let entries = 0; let tableRows = 0;
      for (let j = i + 1; j < lines.length; j++) {
        const next = /^(#{1,6})\s/.exec(lines[j]);
        if (next && next[1].length <= h.level) break;
        if (/^(?:[-*+]|\d+[.)])\s+\S/.test(lines[j])) entries++;               // top-level entries only: a child's own sub-bullets are indented
        else if (/^\s*\|/.test(lines[j]) && !isSeparator(lines[j])) tableRows++;
      }
      const n = Math.max(entries, tableRows - 1);                               // a table's first row is its header
      if (n >= 2) return `its plan has a "${plain(h.text)}" section listing ${n} child items`;
    }
    if (/^\s*\|/.test(lines[i]) && i + 1 < lines.length && isSeparator(lines[i + 1]) && cells(lines[i]).some((c) => CHILD_COLUMN.test(c))) {
      let rows = 0;
      for (let j = i + 2; j < lines.length && /^\s*\|/.test(lines[j]); j++) rows++;
      if (rows >= 2) return `its plan has a table of ${rows} child items`;
    }
  }
  return null;
}
