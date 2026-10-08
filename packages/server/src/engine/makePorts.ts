import { isAbsolute, join } from 'node:path';
import type { Ports } from './ports.ts';
import { LiveGitPort, LiveGhPort, LiveProcPort } from './live-ports.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort, DryRunCodexPort } from './dryrun-ports.ts';
import { LiveCodexPort } from './sessions/LiveCodexPort.ts';
import { LiveClaudePort } from './sessions/LiveClaudePort.ts';
import { resolveClaudeBin } from './sessions/claudeBin.ts';
import type { DataStore } from '../store/DataStore.ts';

export function makePorts(mode: 'live' | 'dry-run', log: (m: string) => void, store: DataStore): Ports {
  if (mode === 'dry-run') {
    const world = new FakeWorld(log, { [`origin/${store.config.code_repo.default_branch}`]: 'f'.repeat(40) });
    // The fake world lives in memory, the items on disk: after a restart, give back what in-flight
    // items say they own, or the reconciler would (correctly) report every worktree as missing.
    for (const item of store.listItems()) {
      const fm = item.file.frontmatter;
      if (!fm.worktree || !fm.branch || fm.status === 'FINISHED') continue;
      const path = isAbsolute(fm.worktree) ? fm.worktree : join(store.codeRepoPath(), fm.worktree);
      const head = fm.ci_head_sha ?? world.sha();
      world.worktrees.set(path, { path, head, branch: fm.branch });
      world.localBranches.add(fm.branch);
      if (!fm.pr) continue;
      world.commits.set(path, 1);
      world.remoteBranches.set(fm.branch, head);
      world.prs.set(fm.pr, { number: fm.pr, url: `https://github.com/${store.config.code_repo.github ?? 'example/repo'}/pull/${fm.pr}`, state: fm.status === 'MERGED' ? 'MERGED' : 'OPEN', headRefOid: head, headRefName: fm.branch, baseRefName: store.derived(item).base_branch ?? store.config.code_repo.default_branch, polls: 0, failOnce: false });
      world.nextPr = Math.max(world.nextPr, fm.pr + 1);
    }
    return { mode, git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: new DryRunClaudePort(world), codex: new DryRunCodexPort(world) } };
  }
  // Resolve the executable only when a Claude turn is actually selected.
  const claude = () => { const resolved = resolveClaudeBin(store.local.claude_bin); log(`Claude sessions run ${resolved.why}`); return new LiveClaudePort(resolved.bin, store.local.anthropic_api_key ?? process.env.ANTHROPIC_API_KEY); };
  return { mode, git: new LiveGitPort(), gh: new LiveGhPort(), proc: new LiveProcPort(), agents: { claude: { runTurn: (o) => claude().runTurn(o), runCustomTurn: (o) => claude().runCustomTurn(o) }, codex: new LiveCodexPort(store.local.codex_bin, [], () => store.config.codex_env_passthrough) } };
}
