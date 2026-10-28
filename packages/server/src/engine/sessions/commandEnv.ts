import type { Config } from '@planestro/shared';
import { codexEnv } from './CodexAppServerPort.ts';

/**
 * The environment a command planestro runs for a worker gets (#218's run_heavy): what that worker's own commands would
 * see. A Claude worker's Bash sees planestro's environment; any other runner's commands see only its passthrough (#228).
 */
export function workerCommandEnv(runner: string, config: Config, secrets: Record<string, string> = {}): { env?: Record<string, string>; cleanEnv?: boolean } {
  // What secret_env hands the worker's session (#501) reaches its heavy runs too.
  return runner === 'claude' ? (Object.keys(secrets).length ? { env: secrets } : {}) : { env: codexEnv(config.codex_env_passthrough, undefined, secrets) as Record<string, string>, cleanEnv: true };
}
