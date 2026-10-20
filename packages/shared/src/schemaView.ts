/**
 * The pure part of the schema (#408): constants and helpers the web needs at runtime, kept apart from
 * the zod schemas so the web's view entry (`@planestro/shared/view`) does not pull zod in. schema.ts
 * re-exports all of it.
 */
import type { ReleaseSectionDef, ModelDef } from './schema.ts';

/** An item's priority (#194), the words of the GitHub labels; unset sorts after low, so items without one order as before. */
export const PRIORITIES = ['high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const RELEASE_STATUSES = ['planned', 'submitted', 'released', 'cancelled'] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];

export const DEFAULT_RELEASE_SECTIONS: ReleaseSectionDef[] = [
  { title: 'Release notes', carry: false, hint: 'What users are told changed.' },
  { title: 'Notes', carry: false, hint: 'Yours: the checklist, what went wrong, what to do differently.' },
];

/**
 * Starting points for `releases.sections` (#376), picked in Settings and then edited like any other. Plain is the
 * default; the store sets show what `max_chars` and `carry` are for.
 */
export const RELEASE_SECTION_PRESETS: { id: string; name: string; summary: string; sections: ReleaseSectionDef[] }[] = [
  { id: 'plain', name: 'Plain', summary: 'Release notes and your own notes.', sections: DEFAULT_RELEASE_SECTIONS },
  { id: 'changelog', name: 'Changelog', summary: 'Keep a Changelog: Added, Changed, Fixed, Removed.', sections: [
    { title: 'Added', carry: false, hint: 'New features.' },
    { title: 'Changed', carry: false, hint: 'Changes to what was already there.' },
    { title: 'Fixed', carry: false, hint: 'Bug fixes.' },
    { title: 'Removed', carry: false, hint: 'Features taken out.' },
    { title: 'Notes', carry: false, hint: 'Yours: the checklist, what went wrong, what to do differently.' },
  ] },
  { id: 'app-store', name: 'iOS App Store', summary: "App Store Connect's fields, with its character limits.", sections: [
    { title: "What's New", max_chars: 4000, carry: false, hint: "App Store Connect → What's New in This Version." },
    { title: 'Subtitle', max_chars: 30, carry: true },
    { title: 'Promotional text', max_chars: 170, carry: true },
    { title: 'Keywords', max_chars: 100, carry: true, hint: 'Comma-separated, no spaces needed.' },
    { title: 'Description', max_chars: 4000, carry: true },
    { title: 'Notes', carry: false, hint: 'Yours: the checklist, what went wrong, what to do differently.' },
  ] },
  { id: 'google-play', name: 'Google Play', summary: "Play Console's store listing fields, with its character limits.", sections: [
    { title: 'Release notes', max_chars: 500, carry: false, hint: "Play Console → the release's notes." },
    { title: 'Short description', max_chars: 80, carry: true },
    { title: 'Full description', max_chars: 4000, carry: true },
    { title: 'Notes', carry: false, hint: 'Yours: the checklist, what went wrong, what to do differently.' },
  ] },
];

/**
 * A preset applied over the sections a project has (#376). Release files keep their text under each heading, so a
 * title the project already has (in any case) keeps its spelling and its text; `dropped` lists the headings the preset
 * leaves out, whose text stays in the files and is shown after the configured sections.
 */
export function applySectionPreset(current: ReleaseSectionDef[], preset: ReleaseSectionDef[]): { sections: ReleaseSectionDef[]; dropped: string[] } {
  const key = (t: string) => t.trim().toLowerCase();
  const sections = preset.map((p) => ({ ...p, title: current.find((c) => key(c.title) === key(p.title))?.title ?? p.title }));
  return { sections, dropped: current.filter((c) => !preset.some((p) => key(p.title) === key(c.title))).map((c) => c.title) };
}

/** The preset a project's sections are, exactly as shipped; undefined once edited. */
export function sectionPresetOf(sections: ReleaseSectionDef[]): string | undefined {
  const same = (a: ReleaseSectionDef, b: ReleaseSectionDef) => a.title === b.title && a.max_chars === b.max_chars && Boolean(a.carry) === Boolean(b.carry) && (a.hint ?? '') === (b.hint ?? '');
  return RELEASE_SECTION_PRESETS.find((p) => p.sections.length === sections.length && p.sections.every((s, i) => same(s, sections[i])))?.id;
}

/** Which agent CLI runs a model's turns. `claude` plans and implements; `codex` implements only. */
export const RUNNERS = ['claude', 'codex'] as const;
export type Runner = typeof RUNNERS[number];

/** Reasoning efforts every model in Codex's catalog offers (`model/list`, 0.154.0). Codex itself accepts any string unchecked. */
export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
export type CodexEffort = typeof CODEX_EFFORTS[number];
/** Service tiers: `default` is standard speed; `priority` (Codex's "Fast") is quicker and drains usage faster. */
export const CODEX_TIERS = ['default', 'priority'] as const;
export type CodexTier = typeof CODEX_TIERS[number];

/** Transport capabilities, including a scoped planning tool contract and accounting mode. */
export function modelCapabilities(m: Pick<ModelDef, 'runner' | 'external' | 'codex_transport'>) {
  const claude = (m.runner ?? 'claude') === 'claude';
  const tools = claude || m.codex_transport === 'app-server';
  return { workerPrompt: !claude && (m.codex_transport ?? 'exec') === 'exec' ? 'worker-system-codex' : 'worker-system',
    toolContract: claude ? 'claude-v1' : m.codex_transport === 'app-server' ? 'app-server-v1' : 'exec-v1', transport: claude ? undefined : m.codex_transport ?? 'exec', roleBound: !claude && m.codex_transport === 'app-server',
    plan: !m.external && tools, orchestrate: !m.external && tools,
    implement: !m.external, permissions: tools, accounting: claude ? 'dollars' as const : 'tokens' as const,
    /** A resumed Codex thread keeps the developer instructions it started with (#246, verified live): new ones need a fresh conversation. */
    resumeKeepsInstructions: !claude,
    /** And the tools (#366): an app-server thread is resumed without its dynamic tools, so a model's MCP servers are the ones it started with. */
    resumeKeepsTools: !claude && m.codex_transport === 'app-server' };
}
/** What a row asks of a Codex turn beyond its model (#245). Nothing for a Claude row. */
export function runnerTurnSettings(m: Pick<ModelDef, 'runner' | 'codex_effort' | 'codex_tier' | 'skills' | 'native_images'> | undefined): { effort?: CodexEffort; serviceTier?: CodexTier; skills?: true; nativeImages?: true } {
  if (!m || (m.runner ?? 'claude') !== 'codex') return {};
  return { ...(m.codex_effort ? { effort: m.codex_effort } : {}), ...(m.codex_tier ? { serviceTier: m.codex_tier } : {}), ...(m.skills ? { skills: true as const } : {}), ...(m.native_images ? { nativeImages: true as const } : {}) };
}
export function canPlan(m: Pick<ModelDef, 'runner' | 'external' | 'codex_transport'>): boolean { return modelCapabilities(m).plan; }
