/**
 * Accounts (#242): more than one login or key for the same runner (two Claude subscriptions, a subscription and an API
 * key). Each is named in planestro.local.yml (`accounts`) with where its credential is; the runner's own login is
 * `default`. A turn runs on the item's account for its runner (the user's "Continue on <account>"), else its model row's,
 * else the default. Usage guards and remembered outages are kept per account. Pure: no I/O, no clock.
 */
import type { LocalConfig, ModelUnavailable, Runner } from './schema.ts';

export const DEFAULT_ACCOUNT = 'default';

/** An account a turn can run on: `default`, or a named one with its credential source. */
export interface Account { name: string; runner: Runner; label: string; home?: string; api_key_env?: string }

type Accounts = Pick<LocalConfig, 'accounts'>;

const named = (local: Accounts, name: string): Account | undefined => {
  const a = local.accounts?.[name];
  return a ? { name, runner: a.runner, label: a.label ?? name, ...(a.home ? { home: a.home } : {}), ...(a.api_key_env ? { api_key_env: a.api_key_env } : {}) } : undefined;
};
const byDefault = (runner: Runner): Account => ({ name: DEFAULT_ACCOUNT, runner, label: DEFAULT_ACCOUNT });

/** Every account on a runner, the default login first. */
export function accountList(local: Accounts, runner: Runner): Account[] {
  return [byDefault(runner), ...Object.keys(local.accounts ?? {}).map((n) => named(local, n)!).filter((a) => a.runner === runner)];
}

/**
 * The account a turn on `runner` runs on. The item's choice counts only for its own account's runner (an item moved onto a
 * Claude account still implements on Codex's login); a model row's must exist here, on that runner. A name this machine
 * does not have is `missing`, never quietly the default login: that would bill whoever is signed in.
 */
export function resolveAccount(local: Accounts, runner: Runner, refs: { item?: string; model?: string }): { account: Account } | { missing: string; why: string } {
  if (refs.item === DEFAULT_ACCOUNT) return { account: byDefault(runner) };
  if (refs.item) {
    const a = named(local, refs.item);
    if (!a) return { missing: refs.item, why: `this item runs on account "${refs.item}", which planestro.local.yml on this machine does not define (accounts.${refs.item})` };
    if (a.runner === runner) return { account: a };
  }
  if (!refs.model || refs.model === DEFAULT_ACCOUNT) return { account: byDefault(runner) };
  const a = named(local, refs.model);
  if (!a) return { missing: refs.model, why: `its model runs on account "${refs.model}", which planestro.local.yml on this machine does not define (accounts.${refs.model} with a home or api_key_env)` };
  if (a.runner !== runner) return { missing: refs.model, why: `its model runs on account "${refs.model}", which is a ${a.runner} account, not ${runner}` };
  return { account: a };
}

const isDefault = (account?: string) => !account || account === DEFAULT_ACCOUNT;

/** The `provider_guards` key for an account: the runner itself for its default login, as before accounts. */
export function guardKey(runner: string, account?: string): string { return isDefault(account) ? runner : `${runner}:${account}`; }

/** The `model_unavailable` key for a model on an account: the id itself on the default login. */
export function unavailableKey(modelId: string, account?: string): string { return isDefault(account) ? modelId : `${modelId}@${account}`; }

/** The outages one account sees, keyed by model id (the map `resolveTurnModel` takes). */
export function unavailableView(map: Record<string, ModelUnavailable> | undefined, account?: string): Record<string, ModelUnavailable> | undefined {
  if (!map) return map;
  const out: Record<string, ModelUnavailable> = {};
  for (const [k, v] of Object.entries(map)) {
    const at = k.lastIndexOf('@');
    if (isDefault(account) ? at < 0 : at > 0 && k.slice(at + 1) === account) out[at < 0 ? k : k.slice(0, at)] = v;
  }
  return out;
}

/**
 * Where an account's conversations are kept: its home (a Claude transcript lives under its CLAUDE_CONFIG_DIR, sdk-notes g;
 * a Codex thread under its CODEX_HOME), '' for the runner's default login, which an account with only a key shares.
 */
function sessionStore(local: Accounts, account?: string): string | undefined {
  if (isDefault(account)) return '';
  const a = local.accounts?.[account!];
  return a ? a.home ?? '' : undefined;
}

/** Whether a conversation one account started can be resumed on another: only from the same store, and never one this machine does not know. */
export function sameSessionStore(local: Accounts, from?: string, to?: string): boolean {
  const a = sessionStore(local, from); const b = sessionStore(local, to);
  return a !== undefined && b !== undefined && a === b;
}
