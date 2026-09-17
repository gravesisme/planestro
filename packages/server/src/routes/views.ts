import { getSection, parseActivity, serializePromptFile, type Status } from '@planestro/shared';
import type { DataStore, StoredItem, StoredPrompt } from '../store/DataStore.ts';

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

export function stateView(store: DataStore, engine: { mode: string; paused: boolean; sessions(): unknown[] }, git: unknown) {
  return {
    schema: store.schema,
    readOnly: store.readOnly,
    dataDir: store.dataDir,
    codeRepo: store.codeRepoPath(),
    config: store.config,
    local: store.local,
    items: store.listItems().map((i) => itemView(store, i)),
    prompts: store.listPrompts().map(promptView),
    invalid: store.invalid,
    engine: { mode: engine.mode, paused: engine.paused, sessions: engine.sessions() },
    git,
    statuses: ['NOT_YET_SUBMITTED', 'QUEUED', 'PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS', 'IN_REVIEW', 'MERGED', 'FINISHED', 'ICEBOX'] satisfies Status[],
  };
}
