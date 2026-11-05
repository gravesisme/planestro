import type { Config } from '@planestro/shared';
import { codexEnv } from './CodexAppServerPort.ts';
import { itemEnv } from './itemEnv.ts';

/**
 * The environment a command planestro runs for a worker gets (#218's run_heavy): what that worker's own commands would
 * see. A Claude worker's Bash sees planestro's environment; any other runner's commands see only its passthrough (#228).
 */
export function workerCommandEnv(runner: string, config: Config, secrets: Record<string, string> = {}, itemId?: string): { env?: Record<string, string>; cleanEnv?: boolean } {
  // What secret_env hands the worker's session (#501) reaches its heavy runs too, and so does PLANESTRO_ITEM (#544).
  const item = itemId ? itemEnv(itemId) : {};
  const mine = { ...secrets, ...item };
  return runner === 'claude' ? (Object.keys(mine).length ? { env: mine } : {}) : { env: { ...(codexEnv(config.codex_env_passthrough, undefined, secrets) as Record<string, string>), ...item }, cleanEnv: true };
}

