import { readFileSync, existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { isoLocal, slugify } from '@planestro/shared';
import type { DataStore } from '../../store/DataStore.ts';

/**
 * LEGACY, PROJECT-SPECIFIC. Before planestro existed its author tracked one game's backlog in a
 * single hand-maintained markdown file; this is the one-off importer that moved those ~90 entries
 * in. Its block grammar, model names and category rules describe that file and nothing else. It is
 * kept as a worked example of a bulk importer (dry-run by default, idempotent by body hash, every
 * write through the DataStore) — copy its shape, not its regexes.
 *
 * The format:
 * blocks separated by `---` lines, section banners (`# COMMON TERMS`, `# [ICEBOX] GAME …`),
 * headers like `# FABLE 5: FINISHED` / `# codex-5.6.sol: FINISHED` (any count, `##` variant),
 * then `## TITLE` and the prompt body. Idempotent by body hash. Dry-run unless {commit: true}.
 */

export interface ImportedRow { kind: 'item' | 'prompt' | 'skipped'; id?: string; name?: string; title: string; status?: string; category?: string; planner?: string; implementer?: string; flags: string[] }
export interface ImportResult { rows: ImportedRow[]; items: number; prompts: number; skipped: number }

const MODEL_MAP: Record<string, string> = { 'FABLE 5': 'fable-5', 'OPUS 5': 'opus-5', 'CODEX-5.6-SOL': 'codex-5.6-sol', 'CODEX-5.6.SOL': 'codex-5.6-sol' };
const STATUS_MAP: Record<string, string> = {
  'NOT SUBMITTED': 'NOT_YET_SUBMITTED', 'NOT YET SUBMITTED': 'NOT_YET_SUBMITTED',
  'PLAN IN PROGRESS': 'PLAN_IN_PROGRESS', 'SUBMITTED': 'IN_PROGRESS', 'IMPLEMENTED': 'IN_PROGRESS',
  'FINISHED': 'FINISHED', 'DONE': 'FINISHED',
};
const WORKTREE_SENTENCE = /^\s*Please perform this work in a new worktree.*$\n?/gim;

/** Curated names for the COMMON TERMS / REPEAT TASKS blocks, keyed by a stable fragment. */
const PROMPT_NAMES: [RegExp, string, string][] = [
  [/perform this work in a new worktree/i, 'new-worktree', 'Ask for the work to happen in a fresh worktree'],
  [/get this work merged into develop.*create a PR/is, 'merge-to-base', 'Create a PR and merge once CI is green'],
  [/rebase the worktree branch with the latest/i, 'rebase-and-update-pr', 'Rebase on the base branch and update the PR'],
  [/monitor the PR and once CI is green/i, 'monitor-ci-and-merge', 'Watch CI and merge when green'],
  [/it will be your turn to merge next/i, 'rebase-then-merge-turn', 'Rebase, update, then merge on your turn'],
  [/clean up the worktree and branch/i, 'cleanup-worktree-manual', 'Remove the worktree and branch'],
  [/merge develop into main to cut a release/i, 'cut-release-manual', 'Promote the default branch to the release branch'],
  [/reviewing the codex.*implementation/is, 'review-codex-branch', 'Review an external implementation before merging'],
  [/Update the marketing site to reflect all changes/i, 'update-marketing-site', 'Refresh the marketing site from recent changes'],
  [/gaps, hardening, performance issues, bugs, optimizations/i, 'audit-repo-full', 'Full repo audit prompt'],
  [/critical performance issues and\/or bugs because a lot of new code/i, 'audit-recent-code-manual', 'Audit recently landed code'],
  [/export_ios\.sh --full/, 'export-ios-full', 'Regenerate the iOS Xcode project'],
  [/open ios\/MyGame\.xcodeproj/, 'open-xcode', 'Open the Xcode project'],
];

interface Block { section: string; text: string }

export function splitBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let section = '';
  let cur: string[] = [];
  const flush = () => { const t = cur.join('\n').trim(); if (t) blocks.push({ section, text: t }); cur = []; };
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line.trim())) inFence = !inFence;
    if (inFence) { cur.push(line); continue; }
    if (/^-{10,}$/.test(line.trim())) {
      // banner: dashes, `# NAME`, dashes
      const name = lines[i + 1]?.trim();
      if (name?.startsWith('# ') && /^-{10,}$/.test(lines[i + 2]?.trim() ?? '')) { flush(); section = name.slice(2).trim(); i += 2; continue; }
      continue;
    }
    if (line.trim() === '---') { flush(); continue; }
    cur.push(line);
  }
  flush();
  return blocks;
}

interface Parsed { title?: string; status?: string; planner?: string; implementer?: string; models: string[]; body: string; headers: string[] }

export function parseBlock(text: string): Parsed {
  const lines = text.split('\n');
  const headers: string[] = [];
  const models: string[] = [];
  let status: string | undefined; let planner: string | undefined; let implementer: string | undefined; let title: string | undefined;
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const h = /^#{1,2}\s+(FABLE 5|OPUS 5|codex-5\.6[.-]sol|CODEX-5\.6[.-]SOL)\s*:\s*(.+)$/i.exec(line);
    const done = /^#{1,2}\s+DONE\s*$/i.exec(line);
    if (h) {
      headers.push(line);
      const model = MODEL_MAP[h[1].toUpperCase().replace('.SOL', '-SOL')] ?? h[1].toLowerCase();
      models.push(model);
      const st = h[2].trim().toUpperCase();
      if (/PLAN/.test(st)) planner = model; else if (/IMPLEMENT/.test(st)) implementer = model;
      for (const [k, v] of Object.entries(STATUS_MAP)) if (st.includes(k)) { status = pickWorse(status, v); break; }
      continue;
    }
    if (done) { headers.push(line); status = pickWorse(status, 'FINISHED'); continue; }
    const t = /^##\s+(.+)$/.exec(line);
    if (t && !title) { title = t[1].trim(); continue; }
    break;
  }
  const body = lines.slice(i).join('\n').trim();
  if (models.length && !planner) planner = models[0];
  if (models.length && !implementer) implementer = models[models.length - 1];
  return { title, status, planner, implementer, models, body, headers };
}

function pickWorse(a: string | undefined, b: string): string {
  const order = ['NOT_YET_SUBMITTED', 'PLAN_IN_PROGRESS', 'IN_PROGRESS', 'FINISHED'];
  if (!a) return b;
  return order.indexOf(b) < order.indexOf(a) ? b : a;
}

function categoryFor(section: string, body: string): string {
  if (/GAME/.test(section) && !/NON-GAME/.test(section)) return 'Game';
  if (/internal tool|tooling|orchestrat|level editor/i.test(body)) return 'Tools';
  if (/marketing site|site|website|mygame\.com|support@|vercel|cloudflare|app store page/i.test(body)) return 'Marketing Site';
  if (/NON-GAME/.test(section)) return 'Chores';
  return 'Not Yet Categorized';
}

export function importPrompts(store: DataStore, filePath: string, opts: { commit: boolean; copySmall?: boolean }): ImportResult {
  const text = readFileSync(filePath, 'utf8');
  const blocks = splitBlocks(text);
  const already = new Set<string>();
  for (const e of store.journal.read({ type: 'import.block' })) if (e.data?.hash) already.add(String(e.data.hash));
  const rows: ImportedRow[] = [];
  const finished: { id?: string; block: Block; parsed: Parsed; hash: string }[] = [];
  let promptCount = 0; let itemCount = 0; let skipped = 0;
  const repo = store.codeRepoPath();
  for (const block of blocks) {
    const hash = createHash('sha1').update(block.text.replace(/\s+/g, ' ')).digest('hex').slice(0, 16);
    const parsed = parseBlock(block.text);
    const flags: string[] = [];
    const isPromptSection = /COMMON TERMS|REPEAT TASKS/.test(block.section);
    if (block.text === '_NONE_' || block.text === 'Playtest' || (!parsed.body && !parsed.title)) { skipped++; rows.push({ kind: 'skipped', title: block.text.slice(0, 60), flags: ['empty'] }); continue; }
    if (already.has(hash)) { skipped++; rows.push({ kind: 'skipped', title: (parsed.title ?? block.text).slice(0, 60), flags: ['already imported'] }); continue; }
    if (isPromptSection) {
      const named = PROMPT_NAMES.find(([re]) => re.test(block.text));
      const name = named?.[1] ?? `imported-${slugify(block.text.split('\n')[0], 30)}`;
      if (store.getPrompt(name)) { skipped++; rows.push({ kind: 'skipped', name, title: name, flags: ['prompt exists'] }); continue; }
      rows.push({ kind: 'prompt', name, title: named?.[2] ?? name, flags });
      promptCount++;
      if (opts.commit) {
        store.putPrompt({ frontmatter: { schema: 1, name, kind: /export_ios|open ios/.test(block.text) ? 'action' : 'template', title: named?.[2] ?? name, description: 'Imported from BACKLOG_PROMPTS.md' }, body: parsed.body || block.text });
        store.journal.append({ type: 'import.block', actor: 'user', data: { hash, name } });
      }
      continue;
    }
    // items
    let status = parsed.status ?? 'NOT_YET_SUBMITTED';
    if (/\[ICEBOX\]/.test(block.section) || (/ICEBOX/.test(block.section) && status === 'NOT_YET_SUBMITTED')) status = 'ICEBOX';
    if (/FINISHED/.test(block.section)) status = 'FINISHED';
    if (/IN PROGRESS/.test(block.section) && status === 'NOT_YET_SUBMITTED') flags.push('section says in progress');
    if (status === 'IN_PROGRESS') { flags.push('was SUBMITTED/IMPLEMENTED by hand → NOT_YET_SUBMITTED for safety'); status = 'NOT_YET_SUBMITTED'; }
    if (status === 'PLAN_IN_PROGRESS') { flags.push('was PLAN IN PROGRESS by hand → NOT_YET_SUBMITTED'); status = 'NOT_YET_SUBMITTED'; }
    let body = block.text.replace(WORKTREE_SENTENCE, '').trim();
    // strip the leading headers/title we already parsed
    for (const h of parsed.headers) body = body.replace(h, '').trim();
    if (parsed.title) body = body.replace(/^##\s+.+$\n?/m, '').trim();
    const firstLine = body.split('\n').find((l) => l.trim())?.trim() ?? '';
    const title = parsed.title ?? ((firstLine.includes('. ') ? firstLine.slice(0, firstLine.indexOf('. ')) : firstLine).replace(/^\.\//, '').slice(0, 70) || 'Untitled');
    if (!parsed.title) flags.push('title generated');
    const category = categoryFor(block.section, body);
    const refs = [...body.matchAll(/\.\/tmp\/[^\s)"']+/g)].map((m) => m[0]);
    const row: ImportedRow = { kind: 'item', title, status, category, planner: parsed.planner, implementer: parsed.implementer, flags };
    rows.push(row);
    itemCount++;
    if (opts.commit) {
      const models = store.config.models.map((m) => m.id);
      const item = store.createItem({
        title, category, description: body, release: null,
        planner: parsed.planner && models.includes(parsed.planner) ? parsed.planner : undefined,
        implementer: parsed.implementer && models.includes(parsed.implementer) ? parsed.implementer : undefined,
        status: status === 'ICEBOX' ? 'ICEBOX' : 'NOT_YET_SUBMITTED',
        extra: { imported_from: basename(filePath) },
      });
      row.id = item.id;
      for (const ref of refs) {
        const abs = resolve(repo, ref);
        if (existsSync(abs) && opts.copySmall && statSync(abs).size <= store.config.attachments.managed_max_bytes && /\.(png|jpe?g|gif|webp)$/i.test(abs)) store.addManagedAttachment(item.id, basename(abs), readFileSync(abs) as Buffer);
        else store.addReferenceAttachment(item.id, ref.replace(/^\.\//, ''));
      }
      if (status === 'FINISHED') finished.push({ id: item.id, block, parsed, hash });
      store.journal.append({ type: 'import.block', actor: 'user', data: { hash, id: item.id } });
    }
  }
  if (opts.commit) {
    // FINISHED items: no dates exist in the file; preserve the file's newest-first order with estimated times
    const t0 = Date.now();
    finished.forEach((f, i) => {
      const when = isoLocal(new Date(t0 - (i + 1) * 60_000));
      store.mutateItem(f.id!, [
        { set: { status: 'FINISHED', finished_at: when, dates_estimated: true } },
        { activity: { actor: 'app', text: 'imported as FINISHED; the real finish date is unknown, order preserved from the file' } },
      ], 'engine');
    });
    store.git.commit(`planestro: import ${itemCount} items, ${promptCount} prompts from ${basename(filePath)}`);
  }
  return { rows, items: itemCount, prompts: promptCount, skipped };
}
