import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { PermissionRules, type PermissionSource, type SourcedRule } from '@planestro/shared';

/**
 * The machine-wide permission policy (#229): an optional `~/.planestro/policy.yml` with `allow`,
 * `deny` and `redirect` (#203) lists, merged with every project's own. It is hand-edited (the UI only shows it) and read
 * again whenever it changes. `PLANESTRO_HOME` moves it, as it moves the project registry.
 */
export const planestroHome = (): string => process.env.PLANESTRO_HOME ?? join(homedir(), '.planestro');
export const machinePolicyPath = (home: string = planestroHome()): string => join(home, 'policy.yml');

export interface MachinePolicyRead extends PermissionRules { path: string; exists: boolean; error?: string }

/** The file as it stands: empty lists when there is none, `error` (and empty lists) when it cannot be read as a policy. */
export function readMachinePolicy(path: string): MachinePolicyRead {
  if (!existsSync(path)) return { path, exists: false, allow: [], deny: [], redirect: [] };
  try {
    const parsed = PermissionRules.strict().safeParse(YAML.parse(readFileSync(path, 'utf8')) ?? {});
    if (!parsed.success) return { path, exists: true, allow: [], deny: [], redirect: [], error: parsed.error.issues.map((i) => `${i.path.join('.') || '(file)'}: ${i.message}`).join('; ') };
    return { path, exists: true, ...clean(parsed.data) };
  } catch (e) {
    return { path, exists: true, allow: [], deny: [], redirect: [], error: String((e as Error).message ?? e) };
  }
}

const clean = (r: PermissionRules): PermissionRules => ({
  allow: r.allow.map((x) => x.trim()).filter(Boolean), deny: r.deny.map((x) => x.trim()).filter(Boolean),
  redirect: r.redirect.map((x) => ({ rule: x.rule.trim(), message: x.message.trim() })).filter((x) => x.rule && x.message),
});

/**
 * The file, read again only when it changes. One that turns unreadable while planestro runs keeps the
 * rules last read from it (its denials must not lapse over a typo) and says what is wrong; one that is
 * unreadable at startup stops it, as an invalid planestro.yml does.
 */
export class MachinePolicy {
  private stamp = '';
  private last: MachinePolicyRead;
  constructor(readonly path: string = machinePolicyPath()) {
    this.last = readMachinePolicy(path);
    if (this.last.error) throw new Error(`invalid ${path}: ${this.last.error}`);
    this.stamp = this.stampOf();
  }
  private stampOf(): string { try { const s = statSync(this.path); return `${s.mtimeMs}:${s.size}`; } catch { return 'none'; } }
  current(): MachinePolicyRead {
    const stamp = this.stampOf();
    if (stamp === this.stamp) return this.last;
    this.stamp = stamp;
    const next = readMachinePolicy(this.path);
    this.last = next.error ? { ...this.last, exists: true, error: next.error } : next;
    return this.last;
  }
}

export interface EffectiveRules extends PermissionRules { rules: SourcedRule[] }

/**
 * Every layer's rules together (#229): each list is the union, in the order machine, project, local,
 * and each rule says which layers name it. A deny from any layer wins over an allow from any layer:
 * the policy judges denials first, and `sdkRules` keeps the SDK from pre-approving what one covers.
 * A redirect (#203) is a deny with its own message; one named by several layers keeps the first one's.
 */
export function permissionRules(layers: Partial<Record<PermissionSource, Partial<PermissionRules> | undefined>>): EffectiveRules {
  const rules: SourcedRule[] = [];
  const add = (rule: string, list: SourcedRule['list'], source: PermissionSource, message?: string) => {
    if (!rule) return;
    const had = rules.find((r) => r.rule === rule && r.list === list);
    if (had) { if (!had.sources.includes(source)) had.sources.push(source); } else rules.push({ rule, list, ...(message !== undefined ? { message } : {}), sources: [source] });
  };
  for (const source of ['machine', 'project', 'local'] as const) {
    const layer = layers[source];
    for (const r of layer?.redirect ?? []) { const message = r.message.trim(); if (message) add(r.rule.trim(), 'redirect', source, message); }
    for (const list of ['deny', 'allow'] as const) for (const raw of layer?.[list] ?? []) add(raw.trim(), list, source);
  }
  const of = (list: SourcedRule['list']) => rules.filter((r) => r.list === list);
  return { allow: of('allow').map((r) => r.rule), deny: of('deny').map((r) => r.rule), redirect: of('redirect').map((r) => ({ rule: r.rule, message: r.message! })), rules };
}
