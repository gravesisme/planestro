import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { Ports } from '../src/engine/ports.ts';
import { describeAction, getSection } from '@planestro/shared';
import { makeFixture } from './helpers.ts';

/**
 * A verify-only item ends blocked no_commits (HH-193): nothing needed changing, and only the user may close
 * it as done. The orchestrator's card now carries the close (#126), so it is one tap, as the user.
 */
let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

async function setup() {
  const { dataDir, codeRepo } = makeFixture();
  mkdirSync(join(codeRepo, '.git', 'info'), { recursive: true });
  const cfg = join(dataDir, 'planestro.yml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^code_repo:\n/m, 'code_repo:\n  github: acme/repo\n'));
  store = await DataStore.open(dataDir, { emit: () => {} });
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: new DryRunClaudePort(world) } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  return { store, engine, world };
}

describe('close_as_done on a decision card (#126)', () => {
  it('the tap closes a no_commits item as done, as the user; a refused close leaves the card', async () => {
    const { store, engine } = await setup();
    const it = store.createItem({ title: 'Verify the cleanup fix', description: 'x' });
    store.mutateItem(it.id, [{ set: { status: 'IN_PROGRESS', blocked: true, blocked_reason: 'no_commits' } }], 'engine');
    const card = { question: 'Close HH-193 as already fixed?', why: 'The fix shipped in #53; nothing needed changing.', options: [
      { label: 'Close as done', description: 'It was verified fixed', recommended: true, action: { tool: 'close_as_done', args: { id: it.id, reason: 'verified fixed by #53' } } },
      { label: 'Send back to the worker', description: 'Look again' },
    ] };
    await (engine as any).askUserDecision(it.id, card);
    await engine.answerDecision(it.id, { choice: 'Close as done' });
    const fm = store.requireItem(it.id).file.frontmatter;
    expect(fm.status).toBe('FINISHED');
    expect(fm.blocked).toBeUndefined();
    const log = getSection(store.requireItem(it.id).file, 'Activity');
    expect(log).toContain(`closed as done without a pull request: verified fixed by #53 (your answer on ${it.id}'s decision card)`);
    expect(log).toMatch(/decided: Close HH-193 as already fixed\? → Close as done \(done for you: .* closed as done\)/);
    // an item with a pull request cannot be closed this way: the card is refused when filed
    const other = store.createItem({ title: 'Has a PR', description: 'x' });
    store.mutateItem(other.id, [{ set: { status: 'IN_PROGRESS', pr: 9, blocked: true, blocked_reason: 'no_commits' } }], 'engine');
    const r = await (engine as any).askUserDecision(other.id, { ...card, options: card.options.map((o) => o.action ? { ...o, action: { tool: 'close_as_done', args: { id: other.id, reason: 'x' } } } : o) });
    expect(String(r)).toMatch(/pull request #9/);
    expect(describeAction({ tool: 'close_as_done', args: { id: it.id, reason: 'x' } })).toMatch(/^closes .* as done without a pull request/);
  });
});
