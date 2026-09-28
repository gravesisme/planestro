import { getSection, parseActivity, serializePromptFile, releaseCandidates, getQuestionSection, parseThread, type Status } from '@planestro/shared';
import type { DataStore, StoredItem, StoredPrompt, StoredRelease, StoredQuestion } from '../store/DataStore.ts';

/** JSON shape of an item as the UI sees it: frontmatter + sections + derived values. */
export function itemView(store: DataStore, item: StoredItem) {
  const fm = item.file.frontmatter;
  return {
    id: fm.id,
    path: item.path,
    frontmatter: fm,
    sections: { Description: getSection(item.file, 'Description'), Notes: getSection(item.file, 'Notes'), Plan: getSection(item.file, 'Plan'), Activity: getSection(item.file, 'Activity') },
    activity: parseActivity(item.file),
    derived: store.derived(item),
  };
}
export type ItemView = ReturnType<typeof itemView>;

export function promptView(p: StoredPrompt) {
  return { name: p.name, path: p.path, frontmatter: p.file.frontmatter, body: p.file.body, text: serializePromptFile(p.file) };
}

/** A release with its sections by title, and the finished work in its window that no release holds yet. */
export function releaseView(store: DataStore, r: StoredRelease) {
  const releases = store.listReleases().map((x) => x.file);
  const items = store.listItems().map((i) => ({ id: i.id, fm: i.file.frontmatter }));
  return {
    version: r.version, path: r.path, frontmatter: r.file.frontmatter,
    sections: r.file.sections.filter((s) => s.title).map((s) => ({ title: s.title, body: s.body })),
    candidates: releaseCandidates(r.version, releases, items).map((i) => i.id),
  };
}
export type ReleaseView = ReturnType<typeof releaseView>;

/**
 * A question as its page shows it. `pending`: a wake about it is queued or running (the engine's
 * memory, not the file's). The list leaves out the details and the thread, which only the page reads.
 */
export function questionView(store: DataStore, q: StoredQuestion, pending: boolean, full = true) {
  const fm = q.file.frontmatter;
  const thread = parseThread(q.file);
  const item = fm.item ? store.getItem(fm.item)?.file.frontmatter : undefined;
  return {
    id: fm.id, path: q.path, frontmatter: fm, pending,
    item_title: item?.title, item_status: item?.status,
    summary: getQuestionSection(q.file, 'Summary'), recommendation: getQuestionSection(q.file, 'Recommendation'),
    messages: thread.length, last_at: thread.at(-1)?.at ?? fm.updated_at,
    ...(full ? { details: getQuestionSection(q.file, 'Details'), thread } : {}),
  };
}
export type QuestionView = ReturnType<typeof questionView>;

/** Who paused automation and, for a usage-guard pause, the window reading that did it. */
export function guardView(store: DataStore, paused: boolean) {
  const e = store.local.engine;
  return paused ? { paused_by: e.paused_by, ...(e.paused_by === 'usage_guard' && e.usage_guard ? { usage_guard: e.usage_guard } : {}) } : {};
}

export function stateView(store: DataStore, engine: { mode: string; paused: boolean; sessions(): unknown[]; restartReadiness?(): { draining: boolean; idle: boolean; running: string[] } }, git: unknown) {
  return {
    schema: store.schema,
    readOnly: store.readOnly,
    dataDir: store.dataDir,
    codeRepo: store.codeRepoPath(),
    config: store.config,
    local: store.local,
    items: store.listItems().map((i) => itemView(store, i)),
    prompts: store.listPrompts().map(promptView),
    releases: store.listReleases().map((r) => releaseView(store, r)),
    invalid: store.invalid,
    engine: { mode: engine.mode, paused: engine.paused, ...guardView(store, engine.paused), sessions: engine.sessions(), ...(engine.restartReadiness ? { restart: engine.restartReadiness() } : {}) },
    git,
    statuses: ['NOT_YET_SUBMITTED', 'QUEUED', 'PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS', 'IN_REVIEW', 'MERGED', 'FINISHED', 'ICEBOX'] satisfies Status[],
  };
}
