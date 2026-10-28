import type { ServerEvent, BreakdownChild } from '@planestro/shared';

/** What the UI/API needs from the engine. Phase 2 ships MockEngine; Phase 3 the real one. */
/** `busy` is false for a turn still queued for its runner's slot (op says so): it has no process yet. */
export interface SessionView { item: string; session_id?: string; model?: string; op?: string; started_at?: string; busy: boolean; last_output?: string }

/** An image a branch added, changed or removed — what a reviewer looks at. */
export interface ReviewImage { path: string; change: 'added' | 'modified' | 'deleted'; bytes?: number; width?: number; height?: number; /** What it is reviewed as; images when absent (older engines). */ kind?: 'image' | 'audio' | 'model' | 'text' }
/** One changed file's unified diff against the base (#233): `patch` is git's, cut at `truncated`. */
export interface ReviewDiff { path: string; change: ReviewImage['change']; patch: string; binary: boolean; truncated: boolean }

/**
 * What Undo last turn would discard (#234): the turn, where it goes back to, the files and patch from its start to its end,
 * the commits it made, and `expect` (its end checkpoint) to confirm with. `refusal` when it cannot be undone, and why.
 */
export interface UndoTurnPreview { refusal: string | null; turn?: number; at?: string; head?: string; files?: { path: string; change: 'added' | 'modified' | 'deleted' }[]; patch?: string; truncated?: boolean; commits?: string; expect?: string }

export interface Engine {
  readonly mode: 'live' | 'dry-run';
  readonly paused: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  pause(): void;
  resume(): void;
  /** Called after an item enters QUEUED; the engine admits it when a slot is free. */
  poke(): void;
  /**
   * `asItem`: the user approves, deliberately, a plan that reads as an epic breakdown (epicFlagOf), which is refused otherwise (#69).
   * `hold`: its pull request stays out of the merge queue until released, for this reason (#97).
   */
  approvePlan(id: string, notes?: string, by?: 'user' | 'orchestrator', opts?: { asItem?: boolean; hold?: string; mcpBudget?: number; syncFirst?: boolean }): Promise<void>;
  /** Make an item an epic or back while nothing has run for implementation (kindConversionRefusal). Returns what happened; throws why not. */
  convertKind(id: string, to: 'item' | 'epic', by?: 'user' | 'orchestrator', why?: string): Promise<string>;
  rejectPlan(id: string, message: string): Promise<void>;
  message(id: string, text: string): Promise<void>;
  respond(id: string, payload: Record<string, unknown>): Promise<void>;
  /** Submit an item as the user does on its page (Triage.submitAsUser): a worker item is queued, an epic has its breakdown planned. Throws the refusal. */
  submitItem(id: string, why: string): Promise<'queued' | 'planning'>;
  /** Have the planner propose an epic's children; `why` prefixes the Activity line (a "start" redirected here). */
  planEpic(id: string, why?: string): Promise<void>;
  /** Create the children (as the user edited them), open the epic and queue what can start. Returns the new ids. */
  approveBreakdown(id: string, children?: BreakdownChild[], opts?: { queue?: boolean }): Promise<string[]>;
  /** Children the user rendered from a list (#239) for an epic not being planned; queued only when asked. Returns the new ids. */
  addChildren(id: string, children: BreakdownChild[], opts?: { queue?: boolean }): Promise<string[]>;
  reviewImages(id: string): Promise<ReviewImage[]>;
  reviewImage(id: string, path: string, side: 'before' | 'after'): Promise<Buffer | null>;
  /** A take of the audition the item waits on (#207), and only while it waits; null for any other path. */
  auditionFile?(id: string, path: string): Promise<Buffer | null>;
  /** A changed file's diff against the base, read from git alone (never the worktree); null for a path the branch did not change. */
  reviewDiff(id: string, path: string): Promise<ReviewDiff | null>;
  requestReviewChanges(id: string, note: string): Promise<void>;
  /** Let a held pull request (a review hold, or skip_merge) back into the merge pipeline; before the pull request exists, drop the hold. */
  releaseHold(id: string, note?: string): Promise<void>;
  /** Finish an item without a pull request: the work landed some other way. User-only. */
  closeAsDone(id: string, reason?: string): Promise<void>;
  /** Send a plan that came back to the user to the orchestrator once more (#153). */
  reviewPlanAgain(id: string): string;
  /** Re-run the failed jobs of the head's red CI run (#139); returns what happened or why not. */
  rerunCi(id: string, by?: 'user' | 'orchestrator'): Promise<string>;
  /** Reopen a PR closed outside planestro and resume its CI wait (#205): the user's, never the orchestrator's. */
  reopenPr(id: string): Promise<string>;
  /** What the Discard dialog shows: the branch, its tip on the remote (null when it is not there) and the PR; `refusal` when it cannot be discarded. */
  discardPreview(id: string): Promise<{ refusal: string | null; branch?: string; remote_sha: string | null; pr?: number }>;
  /** Drop work in progress (#135): close its PR, take it off its epic, icebox it; its remote branch goes only with deleteBranch, leased to expectSha. User-only. Returns what happened. */
  discard(id: string, reason: string, opts?: { deleteBranch?: boolean; expectSha?: string }): Promise<string>;
  /** What undoing the item's last turn would discard, or why it cannot be (#234). */
  undoTurnPreview(id: string): Promise<UndoTurnPreview>;
  /** Put the worktree back as it was before the last turn, confirmed against the preview's `expect`. User-only. Returns what happened. */
  undoTurn(id: string, expect: string): Promise<string>;
  /** A person finishes the item by hand: its live turn is stopped, what was queued for it is dropped, and nothing automatic drives it until handBack. User-only. */
  takeOver(id: string, note?: string): Promise<void>;
  /** The person is done with it: planestro carries on from the item's persisted state. */
  handBack(id: string, note?: string): Promise<void>;
  sessions(): SessionView[];
  continueAfterProviderSwitch?(id: string): void;
  modelSwitchRefusal?(id: string): string | undefined;
  retryProvider?(runner: string): void;
  /** Getting ready for a restart: nothing new starts until undrain (or the restart). Engines without automation leave these out. */
  drain?(by?: 'user' | 'update'): void;
  undrain?(): void;
  restartReadiness?(): { draining: boolean; by?: 'user' | 'update'; idle: boolean; running: string[] };
  /** The CI workflow's runner queue as last read (#170); absent when the engine does not read it. */
  ciQueue?: { queued: number; running: number };
  /** Runner labels that look stalled or offline, and the items waiting on each (#216): the Console's one banner per label. */
  runnerStalls?(): { label: string; items: string[]; since: string }[];
  /** Agents running, turns and ready items waiting for a session slot, and each limited runner's turns (#330). */
  slotUsage?(): { running: number; waiting: number; runners: Record<string, { running: number; waiting: number }> };
  /** Whether a self-hosted runner carrying one of `heavy_runs.shared_labels` (this machine's) is busy (#330). */
  localRunners?(): Promise<{ state: 'busy' | 'idle' | 'unknown'; labels: string[]; detail: string[] }>;
  /** Run a notification command now, as its event would (Settings → Notifications → Test). */
  testNotification?(event: 'on_merge' | 'on_usage_pause' | 'on_needs_you'): Promise<{ code: number; output: string }>;
  /** Every store event, so the engine can tell when an item comes to need you (#224). */
  observe?(e: ServerEvent): void;
  /** A client heartbeat (on input, at most once a minute): someone is using planestro now. */
  clientActive?(): void;
  log: ServerEvent[];
}
