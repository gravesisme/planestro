import type { ItemFrontmatter } from '@planestro/shared';
import type { DataStore } from '../store/DataStore.ts';
import type { GhPort, IssueInfo } from './ports.ts';

/**
 * GitHub issues imported as items (#231, milestone 2). The issues are the project's own: those of `code_repo.github`,
 * the repo its pull requests open in (invariant 5), so a PR can close the issue it came from. Each becomes an item in
 * NOT_YET_SUBMITTED carrying `source: {github_issue: N}`, which is also the evidence that the issue is already in: an
 * import finds it and files nothing. Nothing is submitted (#73): the user queues the item when they want it worked on.
 */
/** How many open issues the import dialog lists, and a label import reads. */
const LIST_LIMIT = 500;

export interface ImportedIssue { issue: number; item: string; title: string }
export interface SkippedIssue { issue: number; reason: string; item?: string }
export interface ImportResult { repo: string; imported: ImportedIssue[]; skipped: SkippedIssue[] }
export interface ImportableIssue { number: number; title: string; url: string; labels: string[]; item?: string }

const refused = (message: string, status = 400) => Object.assign(new Error(message), { status });

function repoOf(store: DataStore): string {
  const repo = store.config.code_repo.github;
  if (!repo) throw refused('code_repo.github is not set: name the GitHub repository issues are imported from (Settings → Project)');
  return repo;
}

/** Items by the issue they were imported from. */
function importedIssues(store: DataStore): Map<number, string> {
  const out = new Map<number, string>();
  for (const it of store.listItems()) { const n = it.file.frontmatter.source?.github_issue; if (n && !out.has(n)) out.set(n, it.id); }
  return out;
}

/** The PR body's line that closes the item's issue when it merges: only when the user asked for it. */
export function closesLine(fm: Pick<ItemFrontmatter, 'source'>): string {
  return fm.source?.closes && fm.source.github_issue ? `\n\nCloses #${fm.source.github_issue}` : '';
}

/** The repo's open issues, newest first, each with the item already imported from it. */
export async function importableIssues(store: DataStore, gh: GhPort): Promise<{ repo: string; label?: string; issues: ImportableIssue[] }> {
  const repo = repoOf(store);
  if (!gh.issueList) throw refused('this engine cannot read issues');
  const done = importedIssues(store);
  const issues = await gh.issueList(repo, { limit: LIST_LIMIT, state: 'open' });
  const label = store.config.issues.import_label;
  return { repo, ...(label ? { label } : {}), issues: issues.map((i) => ({ number: i.number, title: i.title, url: i.url, labels: i.labels ?? [], ...(done.has(i.number) ? { item: done.get(i.number) } : {}) })) };
}

const importing = new Set<string>();

/**
 * Import the issues named, or with none named every open issue with `label` (by default `issues.import_label`). An
 * issue already imported, closed or missing is skipped with the reason; the rest become items, unsubmitted. `closes`
 * asks for their PRs to say `Closes #N`.
 */
export async function importIssues(store: DataStore, gh: GhPort, opts: { issues?: number[]; label?: string; closes?: boolean } = {}): Promise<ImportResult> {
  const repo = repoOf(store);
  if (!gh.issueList || !gh.issueView) throw refused('this engine cannot read issues');
  const label = opts.issues?.length ? undefined : (opts.label ?? store.config.issues.import_label);
  if (!opts.issues?.length && !label) throw refused('name the issues to import, or a label (issues.import_label in Settings → Project, or --label)');
  if (importing.has(store.dataDir)) throw refused('an import is already running', 409);
  importing.add(store.dataDir);
  try {
    const picked: (IssueInfo | { number: number; missing: true })[] = opts.issues?.length
      ? await Promise.all([...new Set(opts.issues)].map(async (n) => (await gh.issueView!(repo, n)) ?? { number: n, missing: true as const }))
      : (await gh.issueList(repo, { limit: LIST_LIMIT, state: 'open', label })).sort((a, b) => a.number - b.number);
    const done = importedIssues(store);
    const result: ImportResult = { repo, imported: [], skipped: [] };
    for (const i of picked) {
      const item = done.get(i.number);
      if (item) { result.skipped.push({ issue: i.number, item, reason: `already imported as ${item}` }); continue; }
      if ('missing' in i) { result.skipped.push({ issue: i.number, reason: `not found in ${repo}` }); continue; }
      if (i.state !== 'OPEN') { result.skipped.push({ issue: i.number, reason: `closed in ${repo}` }); continue; }
      const description = `${i.body.trim()}${i.body.trim() ? '\n\n' : ''}---\nImported from ${i.url}`;
      const it = store.createItem({ title: i.title.trim() || `Issue #${i.number}`, description, extra: { source: { github_issue: i.number, ...(opts.closes ? { closes: true } : {}) } } }, 'user');
      done.set(i.number, it.id);
      result.imported.push({ issue: i.number, item: it.id, title: it.file.frontmatter.title });
    }
    return result;
  } finally { importing.delete(store.dataDir); }
}
