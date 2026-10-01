import YAML from 'yaml';

/**
 * Whether the project's CI runs for a pull request at all, read from its own workflow (invariant 4: a
 * state machine can know this). HH's ci.yml skips a PR whose every changed file is prose
 * (`paths-ignore: ['**.md', 'docs/**']`); planestro read the missing run as "GitHub Actions is
 * blocked", ran the full local gate on HH-324's docs-only change, and blocked it ci_red_twice when
 * that gate was timeout-killed beside others (HH-324). Only the `pull_request` path filters are read:
 * a workflow that does not name the base among its branches is left to the usual start timeout.
 */

/** A GitHub Actions filter pattern as a regular expression: `**` crosses directories, `*` and `?` do not. */
export function filterPattern(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') { if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') { re = re.slice(0, -2) + '(?:.*/)?'; i++; } } else re += '[^/]*'; }
    else if (c === '?') re += '[^/]';
    else if (c === '[') { const end = glob.indexOf(']', i); if (end < 0) re += '\\['; else { re += glob.slice(i, end + 1); i = end; } }
    else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** GitHub's rule for an ordered list with `!` negations: the last pattern that matches decides. */
function matchesFilters(path: string, patterns: string[]): boolean {
  let hit = false;
  for (const p of patterns) { const neg = p.startsWith('!'); if (filterPattern(neg ? p.slice(1) : p).test(path)) hit = !neg; }
  return hit;
}

/** The workflow named `name` among `files` ({ path, text }), by its `name:` or, without one, its file name. */
export function findWorkflow(files: { path: string; text: string }[], name: string): { path: string; doc: any } | undefined {
  for (const f of files) {
    let doc: any; try { doc = YAML.parse(f.text); } catch { continue; }
    const own = typeof doc?.name === 'string' ? doc.name : f.path.split('/').pop();
    if (own === name) return { path: f.path, doc };
  }
  return undefined;
}

/**
 * Why the workflow runs nothing for a pull request changing `files`, or null when it does (or cannot be
 * told). GitHub runs the workflow when any changed file passes the filters; past 300 files it always runs.
 */
export function prSkippedByPaths(doc: any, files: string[]): string | null {
  const on = doc?.on ?? doc?.[true as unknown as string];   // YAML 1.1 reads a bare `on:` key as true
  const pr = on && typeof on === 'object' && !Array.isArray(on) ? on.pull_request : undefined;
  if (!pr || typeof pr !== 'object' || !files.length || files.length >= 300) return null;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const paths = list(pr.paths); const ignore = list(pr['paths-ignore']);
  if (paths.length) return files.some((f) => matchesFilters(f, paths)) ? null : `no changed file matches its paths (${paths.join(', ')})`;
  if (ignore.length) return files.every((f) => matchesFilters(f, ignore)) ? `every changed file matches its paths-ignore (${ignore.join(', ')})` : null;
  return null;
}
