import type { Config } from '@planestro/shared';
import { codexEnv } from './CodexAppServerPort.ts';

/**
 * The environment a command planestro runs for a worker gets (#218's run_heavy): what that worker's own commands would
 * see. A Claude worker's Bash sees planestro's environment; any other runner's commands see only its passthrough (#228).
 */
export function workerCommandEnv(runner: string, config: Config): { env?: Record<string, string>; cleanEnv?: boolean } {
  return runner === 'claude' ? {} : { env: codexEnv(config.codex_env_passthrough) as Record<string, string>, cleanEnv: true };
}
