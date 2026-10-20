import { join, relative, isAbsolute } from 'node:path';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { z } from 'zod';
import { managedLimit, ReviewFlag, Audition, auditionProblem, takePathProblem, auditionTakes, getSection, isoLocal, type Status } from '@planestro/shared';
import type { DataStore, ItemOp } from '../store/DataStore.ts';
import type { TurnPhase } from './ports.ts';
import { AUDITION_PARKED } from './parks.ts';
import { reviewKind } from './reviewKind.ts';

/**
 * Worker tools (#404, seam 1): what a worker puts on its item for the user to see (attachments from its worktree and its
 * review hand-off's pictures and flags), the mid-build audition it parks on, and the files it hands to another item.
 * LiveEngine owns one and delegates to it; this is what it needs from the engine, and nothing more.
 */
export interface WorkerToolsContext {
  readonly store: DataStore;
  /** Turns this engine started and items with a job in flight: read only to see whether a receiver is busy. */
  readonly turns: ReadonlyMap<string, unknown>;
  readonly jobs: ReadonlyMap<string, unknown>;
  now(): string;
  absWorktree(rel: string): string;
  note(level: 'info' | 'warn' | 'error', message: string): void;
  recordPark(id: string, kind: 'audition', what: string, asked: 'user'): string;
  phaseFor(status: Status): TurnPhase | null;
  queueTurn(id: string, phase: TurnPhase, prompt: string): void;
  resumeNote(id: string, reason: string): string;
}

/** The largest take an audition serves (#336): what a review read of a blob takes too (the git port's buffer), never more. */
const MEDIA_MAX_BYTES = 64 * 1024 * 1024;
/** What a worker may put on its item for the user to see (#137): pictures and videos. */
const ATTACHABLE = /\.(png|jpe?g|gif|webp|svg|mp4|webm|mov)$/i;
/** Files one attach call copies onto an item (#355: a review set is dozens of captures, not a sample). */
export const ATTACH_PER_CALL = 48;
const REVIEW_PICTURE = /\.(png|jpe?g|gif|webp)$/i;
const MAX_REVIEW_FLAGS = 100;
const flagLine = (flags: ReviewFlag[]) => flags.slice(0, 5).map((f) => `${f.path}${f.cell ? ` (${f.cell})` : ''}: ${f.reason}`).join('; ').slice(0, 400) + (flags.length > 5 ? ` (+${flags.length - 5} more)` : '');

export class WorkerTools {
  constructor(private readonly ctx: WorkerToolsContext) {}

  /**
   * A worker's hand-off for review (#372): the managed pictures attached since its previous hand-off (or since the item
   * started), and its advisory flags. Flags that fail the schema are left out and said; nothing is refused for them.
   */
  reviewHandoff(id: string, flags: unknown): { ops: ItemOp[]; attached: number; said: string } {
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    const since = fm.review_handoff?.at ?? fm.started_at ?? '';
    // isoLocal, as the attachments' added_at is: the store stamps them by the wall clock.
    const at = isoLocal();
    // Stamps are to the second: one the previous hand-off already showed is not its again.
    const before = new Set(fm.review_handoff?.attached ?? []);
    const attached = fm.attachments.filter((a) => a.kind === 'managed' && REVIEW_PICTURE.test(a.path) && a.added_at >= since && !before.has(a.path)).map((a) => a.path);
    const parsed = flags === undefined ? undefined : z.array(ReviewFlag).max(MAX_REVIEW_FLAGS).safeParse(flags);
    const list = parsed?.success ? parsed.data : [];
    const ops: ItemOp[] = [{ set: { review_handoff: { at, attached, ...(list.length ? { flags: list } : {}) } } }];
    if (list.length) ops.push({ activity: { actor: 'worker', text: `flagged for a look: ${flagLine(list)}` } });
    const said = parsed && !parsed.success ? `Flags not recorded: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'flags'}: ${i.message}`).join('; ').slice(0, 300)}.` : list.length ? `Flagged ${list.length} for a look.` : '';
    return { ops, attached: attached.length, said };
  }

  /** Flags a worker adds with a note (#372): joined to its hand-off's (one per path and cell, the newest reason kept). */
  addReviewFlags(id: string, flags: unknown): string {
    const parsed = z.array(ReviewFlag).max(MAX_REVIEW_FLAGS).safeParse(flags);
    if (!parsed.success) return `Flags not recorded: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'flags'}: ${i.message}`).join('; ').slice(0, 300)}.`;
    if (!parsed.data.length) return '';
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    const prev = fm.review_handoff;
    const key = (f: ReviewFlag) => `${f.path}\u0000${f.cell ?? ''}`;
    const merged = new Map((prev?.flags ?? []).map((f) => [key(f), f]));
    for (const f of parsed.data) merged.set(key(f), f);
    const all = [...merged.values()].slice(-MAX_REVIEW_FLAGS);
    this.ctx.store.mutateItem(id, [{ set: { review_handoff: { ...(prev ?? { at: isoLocal(), attached: [] }), flags: all } } }, { activity: { actor: 'worker', text: `flagged for a look: ${flagLine(parsed.data)}` } }], 'engine', { commit: `${id}: review flags` });
    return `Flagged ${parsed.data.length} for a look.`;
  }

  /**
   * What a worker shows the user (#137, LM-38): images and videos from its worktree, its ignored cache included,
   * copied onto the item as managed attachments (the item page shows them). Only files inside the worktree, of a
   * picture or video type, within attachments.managed_max_bytes. Returns what it did and skipped, for the worker.
   */
  attachFromWorktree(id: string, paths: string[] | undefined): string {
    if (!paths?.length) return '';
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    if (!fm.worktree) return 'Nothing attached: this item has no worktree.';
    let root: string;
    try { root = realpathSync(this.ctx.absWorktree(fm.worktree)); } catch { return 'Nothing attached: the worktree is not there.'; }
    const done: string[] = []; const skipped: string[] = [];
    for (const p of paths.slice(0, ATTACH_PER_CALL)) {
      const rel = relative(root, join(root, p));
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) { skipped.push(`${p} (outside your worktree)`); continue; }
      if (!ATTACHABLE.test(p)) { skipped.push(`${p} (not an image or video)`); continue; }
      try {
        // A link is followed only where it stays inside: `shot.png -> ~/.aws/credentials` would be committed with the data dir.
        const abs = realpathSync(join(root, p));
        if (!abs.startsWith(root + '/')) { skipped.push(`${p} (links outside your worktree)`); continue; }
        const st = statSync(abs);
        if (!st.isFile()) { skipped.push(`${p} (not a file)`); continue; }
        const max = managedLimit(this.ctx.store.config.attachments, p);
        if (st.size > max) { skipped.push(`${p} (${st.size} bytes, over attachments.${max === this.ctx.store.config.attachments.managed_max_bytes ? 'managed_max_bytes' : 'image_max_bytes'} ${max})`); continue; }
        const data = readFileSync(abs);
        this.ctx.store.addManagedAttachment(id, rel.replace(/[\/\\]/g, '-'), data, 'engine');
        done.push(p);
      } catch (e) { skipped.push(`${p} (${(e as Error).message.replace(/\s+/g, ' ').slice(0, 120)})`); }
    }
    if (paths.length > ATTACH_PER_CALL) skipped.push(`${paths.length - ATTACH_PER_CALL} more (at most ${ATTACH_PER_CALL} a call: call add_note with the rest)`);
    return [done.length ? `Attached for the user: ${done.join(', ')}.` : '', skipped.length ? `Not attached: ${skipped.join('; ')}.` : ''].filter(Boolean).join(' ');
  }

  // ---- a mid-build audition (#207) ----
  /**
   * The worker's takes, put to the user before it builds on one: the item parks on them (`awaiting: audition`) like a
   * question, but never goes to triage, since listening and choosing is the designer's. Every take must be a file inside
   * the worktree (ignored folders included) that a person reviews by eye or ear; a refusal is answered in words.
   */
  requestAudition(id: string, input: unknown): string {
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    if (fm.taken_over) return 'Not recorded: the user has taken this item over. Stop now and end your turn.';
    if (fm.awaiting) return `Not recorded: ${id} is already awaiting ${fm.awaiting.replace(/_/g, ' ')}. End your turn now.`;
    if (!fm.worktree) return 'Rejected: this item has no worktree to play takes from.';
    const parsed = Audition.safeParse(input);
    if (!parsed.success) return `Rejected: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'audition'}: ${i.message}`).join('; ').slice(0, 600)}. Fix it and call request_audition again.`;
    const audition = parsed.data;
    const problem = auditionProblem(audition) ?? auditionTakes(audition).map((t) => this.takeProblem(fm.worktree!, t)).find(Boolean);
    if (problem) return `Rejected: ${problem}. Fix it and call request_audition again.`;
    const takes = audition.roles.reduce((n, r) => n + r.takes.length, 0);
    const park = this.ctx.recordPark(id, 'audition', audition.title, 'user');
    this.ctx.store.mutateItem(id, [{ set: { awaiting: 'audition', awaiting_data: { audition, requested_at: this.ctx.now(), park } } }, { activity: { actor: 'app', text: `parked: audition "${audition.title}" (${audition.roles.length} role${audition.roles.length === 1 ? '' : 's'}, ${takes} take${takes === 1 ? '' : 's'})` } }], 'engine', { commit: `${id}: awaiting audition` });
    this.ctx.note('info', `${id}: ${takes} take${takes === 1 ? '' : 's'} to audition (${audition.title})`);
    return `${AUDITION_PARKED}: the user hears the takes, keeps what each role needs and may ask for the rest again. End your turn now; planestro resumes you with the picks.`;
  }

  /** Why a take cannot be played from this worktree: missing, not a file a person reviews, or (through a link) outside it. */
  private takeProblem(worktree: string, take: string): string | undefined {
    const bad = takePathProblem(take);
    if (bad) return bad;
    if (!reviewKind(take)) return `${take} is not an image, sound or model`;
    const root = this.ctx.absWorktree(worktree);
    try {
      const real = realpathSync(join(root, take)); const rel = relative(realpathSync(root), real);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) return `${take} leaves your worktree`;
      if (!statSync(real).isFile()) return `${take} is not a file`;
    } catch { return `${take} does not exist in your worktree`; }
    return undefined;
  }

  /** A take of the audition the item waits on, and nothing else: no other path, and nothing once it is answered. */
  async auditionFile(id: string, path: string): Promise<Buffer | null> {
    const fm = this.ctx.store.requireItem(id).file.frontmatter;
    if (fm.awaiting !== 'audition' || !fm.worktree) return null;
    const audition = Audition.safeParse(fm.awaiting_data?.audition);
    if (!audition.success || !auditionTakes(audition.data).includes(path) || this.takeProblem(fm.worktree, path)) return null;
    const abs = join(this.ctx.absWorktree(fm.worktree), path);
    try { return statSync(abs).size > MEDIA_MAX_BYTES ? null : readFileSync(abs); } catch { return null; }
  }

  // ---- hand-off: one item's files, given to another before any branch merges ----
  /**
   * The receiving item must already be tied to the giver (it waits on it, or they share an epic):
   * a hand-off is a delivery along a dependency, not a message to anyone. planestro does the
   * copying (invariant 1: a worker writes only its worktree), the files become the receiver's
   * attachments — which every one of its turns lists — and its session, if it has one, is told.
   */
  async handOff(from: string, to: string, paths: string[], note: string, by: 'worker' | 'orchestrator' | 'user' = 'worker'): Promise<string> {
    const giver = this.ctx.store.requireItem(from);
    const receiver = this.ctx.store.getItem(to);
    if (!receiver) return `Rejected: no item ${to}.`;
    if (to === from) return 'Rejected: an item cannot hand files to itself.';
    const rfm = receiver.file.frontmatter; const gfm = giver.file.frontmatter;
    if (this.ctx.store.derived(receiver).lane !== 'board') return `Rejected: ${to} is ${rfm.status}; only an item on the board can receive files.`;
    const related = rfm.depends_on.includes(from) || (gfm.parent !== undefined && gfm.parent === rfm.parent) || rfm.parent === from;
    if (!related) return `Rejected: ${to} does not wait on ${from} (its depends_on does not name it) and they share no epic. Ask the user to add the dependency, or report_blocked with what you need.`;
    if (!gfm.worktree) return `Rejected: ${from} has no worktree to hand files from.`;
    const root = realpathSync(this.ctx.absWorktree(gfm.worktree));
    const max = this.ctx.store.config.attachments.managed_max_bytes;
    const copied: string[] = [];
    for (const p of paths) {
      if (isAbsolute(p)) return `Rejected: "${p}" — paths are relative to your worktree.`;
      let abs: string;
      try { abs = realpathSync(join(root, p)); } catch { return `Rejected: "${p}" does not exist in the worktree.`; }
      if (abs !== root && !abs.startsWith(root + '/')) return `Rejected: "${p}" is outside the worktree.`;
      const st = statSync(abs);
      if (!st.isFile()) return `Rejected: "${p}" is not a file.`;
      if (st.size > max) return `Rejected: "${p}" is ${st.size} bytes; a hand-off file may be at most ${max} (attachments.managed_max_bytes). Hand off the deliverable itself, not previews or scratch.`;
      copied.push(this.ctx.store.addManagedAttachment(to, p.replace(/\//g, '__'), readFileSync(abs), 'engine').path);
    }
    const absPaths = copied.map((rel) => join(this.ctx.store.dataDir, rel));
    const who = by === 'worker' ? `${from}'s worker` : by === 'orchestrator' ? `the orchestrator, from ${from}` : `the user, from ${from}`;
    const noteText = note.trim();
    const memo = `Hand-off from ${from} (${isoLocal().slice(0, 16).replace('T', ' ')}): ${copied.length} file${copied.length === 1 ? '' : 's'} attached to this item — ${absPaths.join(', ')}${noteText ? `\n\n${noteText}` : ''}`;
    const curNotes = getSection(this.ctx.store.requireItem(to).file, 'Notes');
    this.ctx.store.mutateItem(to, [{ section: 'Notes', body: curNotes ? `${curNotes}\n\n${memo}` : memo }, { activity: { actor: 'app', text: `received ${copied.length} file${copied.length === 1 ? '' : 's'} from ${who}: ${paths.join(', ')}` } }], 'engine', { commit: `${to}: hand-off from ${from}` });
    this.ctx.store.mutateItem(from, [{ activity: { actor: by === 'worker' ? 'worker' : by, text: `handed ${copied.length} file${copied.length === 1 ? '' : 's'} to ${to}: ${paths.join(', ')}` } }], 'engine');
    this.ctx.store.journal.append({ type: 'item.handoff', item: to, actor: 'engine', data: { from, files: copied, note: noteText.slice(0, 500) } });
    // Tell the receiver's session. Parked on something other than the user → it reads this at its next turn; idle → that turn starts now.
    const phase = this.ctx.phaseFor(rfm.status);
    let told = 'it has no session yet; the files and your note are in its attachments and notes for when it starts';
    if (phase) {
      const text = `${from} handed off ${copied.length} file${copied.length === 1 ? '' : 's'} to you, now attached to your item:\n${absPaths.map((p) => `- ${p}`).join('\n')}${noteText ? `\n\n${noteText}` : ''}`;
      const cur = this.ctx.store.requireItem(to).file.frontmatter;
      if (cur.taken_over) told = 'the user has taken it over; the files and your note are in its attachments and notes';
      // A block (budget, a failure) or a decision card is for whoever resolves it: resuming here ran a turn on a blocked
      // item, past its cap, and dropped the card. The hand-off waits for the turn that resolution starts.
      else if (this.ctx.turns.has(to) || this.ctx.jobs.has(to) || (cur.awaiting && cur.awaiting !== 'user') || cur.blocked || cur.awaiting_data?.decision) {
        const pending = [...((cur.op_data?.pending_messages as string[] | undefined) ?? []), text];
        this.ctx.store.mutateItem(to, [{ set: { op_data: { ...(cur.op_data ?? {}), pending_messages: pending } } }], 'engine');
        told = cur.blocked ? `it is blocked (${cur.blocked_reason ?? 'no reason given'}) and will read the hand-off when it is unblocked`
          : cur.awaiting_data?.decision ? 'it waits on a decision from the user and will read the hand-off once that is answered'
          : cur.awaiting && cur.awaiting !== 'user' ? `its session is parked (awaiting ${cur.awaiting}) and will read the hand-off when it resumes` : 'its session is busy and will read the hand-off at its next turn';
      } else {
        this.ctx.store.mutateItem(to, [{ unset: ['awaiting', 'awaiting_data'] }], 'engine');
        this.ctx.queueTurn(to, phase, `${this.ctx.resumeNote(to, `a hand-off from ${from}`)}\n\n${text}`);
        told = 'its session has been resumed with the hand-off';
      }
    }
    return `Delivered to ${to}: ${copied.length} file${copied.length === 1 ? '' : 's'} attached; ${told}.`;
  }
}
