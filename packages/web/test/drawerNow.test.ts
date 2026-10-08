import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { Config, ItemFrontmatter } from '@planestro/shared';
import type { ItemView, SessionView, State } from '../src/api.ts';

const fixture = vi.hoisted(() => ({ current: {} as any }));
vi.mock('../src/store.ts', () => ({ useStore: (selector: (s: any) => any) => selector(fixture.current), act: () => {}, showError: () => {} }));
import { isActiveItem, nowOf, phaseTrack } from '../src/drawerNow.ts';
import { activityFeed } from '../src/activityFeed.ts';
import { PreviewDrawer } from '../src/components/PreviewDrawer.tsx';

/**
 * #314: the quick view of an active item was laid out around the brief. It now opens on what is happening: one "Now"
 * sentence, where the item is in its lifecycle, the console, and the newest activity first, with repeats grouped.
 */
const NOW = new Date('2026-10-08T11:10:00Z');
const config = Config.parse({
  schema_version: 3, tool_version: '0.1.0', project: { name: 'T', id_prefix: 'TP' }, code_repo: { path: '.', default_branch: 'trunk', github: 'o/r' },
  defaults: { planner: 'm', implementer: 'm', category: 'c' }, categories: ['c'], concurrency: { max_sessions: 2 },
  models: [{ id: 'm', label: 'M', claude_model: 'x' }, { id: 'cx', label: 'Codex', runner: 'codex', codex_model: 'y' }],
});
let item: ItemView;
let state: State;
const view = (fields: Record<string, unknown>, id = 'TP-1') => ({
  id, path: `items/${id}.md`,
  frontmatter: ItemFrontmatter.parse({ schema: 4, id, title: `${id} title`, category: 'c', created_at: '2026-10-07T00:00:00Z', updated_at: '2026-10-07T00:00:00Z', status: 'IN_PROGRESS', planner: 'm', implementer: 'm', ...fields }),
  sections: { Description: 'A long brief.\n\nWith more paragraphs.', Notes: '', Plan: 'The plan.', Activity: '' }, activity: [],
  derived: { lane: 'board', needs_you: false, external: false, flavor: 'worker', deps_satisfied: true, children: [], base_branch: 'trunk' },
}) as unknown as ItemView;
const withState = (items: ItemView[], sessions: SessionView[] = []) => ({ config, local: { model_unavailable: {} }, engine: { paused: false, provider_guards: {}, sessions }, items, releases: [] } as unknown as State);
beforeEach(() => { item = view({}); state = withState([item]); });
const say = () => nowOf(item, state, NOW);

describe('the Now sentence says what is happening to an active item (#314)', () => {
  it('a running session: its phase, how long the turn has run, and its last output', () => {
    state.engine.sessions = [{ item: 'TP-1', op: 'implement', busy: true, started_at: '2026-10-08T11:04:00Z', last_output: 'Editing src/board.ts' }];
    expect(say()).toMatchObject({ tone: 'running', text: 'implementing… · 6 min', output: 'Editing src/board.ts' });
  });

  it('a running session on a runner counted in turns says which turn of its cap', () => {
    item = view({ implementer: 'cx', agent_turns: 3, budget_turns: 20 }); state = withState([item], [{ item: 'TP-1', op: 'implement', busy: true, started_at: '2026-10-08T11:09:40Z' }]);
    expect(say()).toMatchObject({ tone: 'running', text: 'implementing… · <1 min · turn 4 of 20' });
  });

  it('a turn waiting for a session slot says how many are busy', () => {
    item.frontmatter.op_data = { pending_turn: { key: 'k', phase: 'implement', prompt: 'p' } };
    state.engine.sessions = [{ item: 'TP-2', op: 'implement', busy: true }, { item: 'TP-3', op: 'plan', busy: true }];
    expect(say()).toMatchObject({ tone: 'wait', text: 'waiting for a slot (2 of 2 busy)' });
    state.engine.paused = true; // another wait keeps #299's own words
    expect(say()).toMatchObject({ tone: 'wait', text: 'Waiting for automation to resume.' });
  });

  it('CI running: since when, and the run when it is known', () => {
    item = view({ status: 'IN_REVIEW', pr: 9, op: 'awaiting_ci', op_started_at: '2026-10-08T11:06:00Z', ci_result: 'pending', ci_head_sha: 'abc', op_data: { ci_rerun: { sha: 'abc', runId: 4242 } } });
    expect(say()).toMatchObject({ tone: 'ci', text: 'CI running · run 4242 · 4 min' });
  });

  it('a decision on the user names it', () => {
    item = view({ status: 'PLAN_READY', awaiting: 'plan_approval' }); item.derived.needs_you = true;
    expect(say()).toMatchObject({ tone: 'you', text: 'waiting on you: plan approval' });
    item = view({ blocked: true, blocked_reason: 'stalled', awaiting: 'user', awaiting_data: { decision: { question: 'Retry?', options: [{ label: 'Yes' }] } } }); item.derived.needs_you = true;
    expect(say()).toMatchObject({ tone: 'you', text: 'waiting on you: a decision' });
  });

  it('a block names its reason, and a block the orchestrator is on says it is triaging', () => {
    item = view({ blocked: true, blocked_reason: 'ci_red_parked' });
    expect(say()).toMatchObject({ tone: 'blocked', text: 'blocked: ci red parked' });
    item = view({ blocked: true, blocked_reason: 'stalled', triage: { reason: 'stalled', started_at: '2026-10-08T11:00:00Z' } });
    expect(say()).toMatchObject({ tone: 'triage', text: 'orchestrator triaging: stalled' });
  });

  it('a held PR says why it is held', () => {
    item = view({ status: 'IN_REVIEW', pr: 9, skip_merge: true, hold_reason: 'waits on the art pass', ci_result: 'green' });
    expect(say()).toMatchObject({ tone: 'held', text: 'held: waits on the art pass · CI green' });
  });

  it('which items count as active', () => {
    expect(isActiveItem(view({ status: 'IN_PROGRESS' }), state)).toBe(true);
    expect(isActiveItem(view({ status: 'PLAN_READY' }), state)).toBe(true);
    expect(isActiveItem(view({ status: 'NOT_YET_SUBMITTED' }), state)).toBe(false);
    expect(isActiveItem(view({ status: 'QUEUED' }), state)).toBe(false);
    expect(isActiveItem(view({ status: 'FINISHED' }), state)).toBe(false);
    expect(isActiveItem(view({ status: 'ICEBOX' }), state)).toBe(false);
    expect(isActiveItem(view({ status: 'QUEUED' }), withState([], [{ item: 'TP-1', op: 'plan: waiting for a claude slot', busy: false }]))).toBe(true);
    expect(isActiveItem(view({ status: 'MERGED', op: 'cleaning_up' }), state)).toBe(true);
  });
});

describe('the phase track lights the current step (#314)', () => {
  it('follows the status, with the time each finished step took', () => {
    const fm = view({ status: 'IN_PROGRESS', queued_at: '2026-10-08T09:00:00Z', started_at: '2026-10-08T09:02:00Z', plan_ready_at: '2026-10-08T09:30:00Z', plan_approved_at: '2026-10-08T10:30:00Z' }).frontmatter;
    const track = phaseTrack(fm, NOW);
    expect(track.map((s) => s.label)).toEqual(['Queued', 'Planning', 'Plan ready', 'Implementing', 'Review/CI', 'Merged']);
    expect(track.map((s) => s.state)).toEqual(['done', 'done', 'done', 'current', 'todo', 'todo']);
    expect(track.map((s) => s.spent)).toEqual(['2 min', '28 min', '1 h', '40 min', undefined, undefined]);
    expect(phaseTrack(view({ status: 'IN_REVIEW' }).frontmatter, NOW).find((s) => s.state === 'current')?.label).toBe('Review/CI');
    expect(phaseTrack(view({ status: 'PLAN_IN_PROGRESS' }).frontmatter, NOW).find((s) => s.state === 'current')?.label).toBe('Planning');
    expect(phaseTrack(view({ status: 'MERGED' }).frontmatter, NOW).every((s) => s.state === 'done' || s.label === 'Merged')).toBe(true);
  });
});

describe('activity reads newest first, with repeats grouped (#314)', () => {
  const at = (m: number) => `2026-10-08T11:${String(m).padStart(2, '0')}:00+00:00`;
  const log = [
    { at: at(0), actor: 'worker', text: 'plan approved; implementing' },
    ...[1, 2, 3, 4, 5].map((m) => ({ at: at(m), actor: 'user', text: `attached attachments/capture-${m}.png` })),
    { at: at(6), actor: 'worker', text: 'pushed 2 commits' },
  ];

  it('the newest entry comes first and consecutive attachments become one line', () => {
    const feed = activityFeed(log);
    expect(feed.map((g) => g.text)).toEqual(['pushed 2 commits', 'attached 5 images', 'plan approved; implementing']);
    expect(feed[1]).toMatchObject({ at: at(5), actor: 'user', entries: expect.any(Array) });
    expect(feed[1].entries.map((e) => e.text)).toEqual([5, 4, 3, 2, 1].map((m) => `attached attachments/capture-${m}.png`));
  });

  it('keeps a limit of lines, and leaves different entries apart', () => {
    expect(activityFeed(log, 2).map((g) => g.text)).toEqual(['pushed 2 commits', 'attached 5 images']);
    const mixed = [{ at: at(1), actor: 'user', text: 'attached a.png' }, { at: at(2), actor: 'worker', text: 'attached b.txt' }, { at: at(3), actor: 'worker', text: 'attached c.txt' }];
    expect(activityFeed(mixed).map((g) => g.text)).toEqual(['attached 2 files', 'attached a.png']);
    expect(activityFeed([{ at: at(1), actor: 'app', text: 'CI red on abc' }, { at: at(2), actor: 'app', text: 'CI green on def' }]).map((g) => g.text)).toEqual(['CI green on def', 'CI red on abc']);
  });
});

describe("the drawer's layout (#314)", () => {
  const render = (it: ItemView, sessions: SessionView[] = []) => {
    fixture.current = { state: withState([it], sessions), chat: {}, consoles: {}, seedConsole: () => {} };
    return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(PreviewDrawer, { id: it.id, onClose: () => {} })));
  };

  it('an active item opens on the Now strip, then the console, then the newest activity; the brief folds to the bottom', () => {
    const it = view({ status: 'IN_PROGRESS', pr: 9, ci_result: 'pending', branch: 'feature/x' });
    it.activity = [{ at: '2026-10-08T11:00:00+00:00', actor: 'worker', text: 'old entry' }, { at: '2026-10-08T11:05:00+00:00', actor: 'worker', text: 'new entry' }];
    const html = render(it, [{ item: 'TP-1', op: 'implement', busy: true, started_at: '2026-10-08T11:04:00Z' }]);
    const order = ['class="drawer-now', 'class="phase-track', 'Console', 'new entry', 'old entry', 'Brief'].map((s) => html.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).not.toContain('With more paragraphs');           // folded
    expect(html).not.toContain('let the orchestrator approve the plan');
    expect(html).not.toContain('session running');                // the pill row is gone
  });

  it('a non-active item keeps its brief first', () => {
    const html = render(view({ status: 'NOT_YET_SUBMITTED' }));
    expect(html).not.toContain('drawer-now');
    expect(html).toContain('With more paragraphs');
    expect(html).toContain('let the orchestrator approve the plan');
  });

  it('a plan awaiting approval stays in view', () => {
    const it = view({ status: 'PLAN_READY', awaiting: 'plan_approval' }); it.derived.needs_you = true;
    const html = render(it);
    expect(html).toContain('drawer-now');
    expect(html).toContain('Plan awaiting your approval');
    expect(html).toContain('let the orchestrator approve the plan');
  });
});
