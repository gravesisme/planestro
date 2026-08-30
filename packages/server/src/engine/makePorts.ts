import type { Ports } from './ports.ts';
import { LiveGitPort, LiveGhPort, LiveProcPort } from './live-ports.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from './dryrun-ports.ts';
import { LiveClaudePort } from './sessions/LiveClaudePort.ts';
import type { DataStore } from '../store/DataStore.ts';

export function makePorts(mode: 'live' | 'dry-run', log: (m: string) => void, store: DataStore): Ports {
  if (mode === 'dry-run') {
    const world = new FakeWorld(log, { [`origin/${store.config.code_repo.default_branch}`]: 'f'.repeat(40) });
    return { mode, git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), claude: new DryRunClaudePort(world) };
  }
  return { mode, git: new LiveGitPort(), gh: new LiveGhPort(), proc: new LiveProcPort(), claude: new LiveClaudePort(store.local.claude_bin) };
}
