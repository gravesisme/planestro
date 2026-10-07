import type { ServerEvent, BreakdownChild } from '@planestro/shared';

/** What the UI/API needs from the engine. Phase 2 ships MockEngine; Phase 3 the real one. */
/** `busy` is false for a turn still queued for its runner's slot (op says so): it has no process yet. */
export interface SessionView { item: string; session_id?: string; model?: string; op?: string; started_at?: string; busy: boolean; last_output?: string }

/** An image a branch added, changed or removed — what a reviewer looks at. */
export interface ReviewImage { path: string; change: 'added' | 'modified' | 'deleted'; bytes?: number; width?: number; height?: number; /** What it is reviewed as; images when absent (older engines). */ kind?: 'image' | 'audio' | 'model' }

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
  approvePlan(id: string, notes?: string, by?: 'user' | 'orchestrator', opts?: { asItem?: boolean; hold?: string; mcpBudget?: number }): Promise<void>;
  /** Make an item an epic or back while nothing has run for implementation (kindConversionRefusal). Returns what happened; throws why not. */
  convertKind(id: string, to: 'item' | 'epic', by?: 'user' | 'orchestrator', why?: string): Promise<string>;
  rejectPlan(id: string, message: string): Promise<void>;
  message(id: string, text: string): Promise<void>;
  respond(id: string, payload: Record<string, unknown>): Promise<void>;
  /** Have the planner propose an epic's children; `why` prefixes the Activity line (a "start" redirected here). */
  planEpic(id: string, why?: string): Promise<void>;
  /** Create the children (as the user edited them), open the epic and queue what can start. Returns the new ids. */
  approveBreakdown(id: string, children?: BreakdownChild[], opts?: { queue?: boolean }): Promise<string[]>;
  reviewImages(id: string): Promise<ReviewImage[]>;
  reviewImage(id: string, path: string, side: 'before' | 'after'): Promise<Buffer | null>;
  requestReviewChanges(id: string, note: string): Promise<void>;
  /** Let a held pull request (a review hold, or skip_merge) back into the merge pipeline; before the pull request exists, drop the hold. */
  releaseHold(id: string, note?: string): Promise<void>;
  /** Finish an item without a pull request: the work landed some other way. User-only. */
  closeAsDone(id: string, reason?: string): Promise<void>;
  /** Send a plan that came back to the user to the orchestrator once more (#153). */
  reviewPlanAgain(id: string): string;
  /** Re-run the failed jobs of the head's red CI run (#139); returns what happened or why not. */
  rerunCi(id: string, by?: 'user' | 'orchestrator'): Promise<string>;
  /** What the Discard dialog shows: the branch, its tip on the remote (null when it is not there) and the PR; `refusal` when it cannot be discarded. */
  discardPreview(id: string): Promise<{ refusal: string | null; branch?: string; remote_sha: string | null; pr?: number }>;
  /** Drop work in progress (#135): close its PR, take it off its epic, icebox it; its remote branch goes only with deleteBranch, leased to expectSha. User-only. Returns what happened. */
  discard(id: string, reason: string, opts?: { deleteBranch?: boolean; expectSha?: string }): Promise<string>;
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
  /** Run a notification command now, as its event would (Settings → Notifications → Test). */
  testNotification?(event: 'on_merge' | 'on_usage_pause'): Promise<{ code: number; output: string }>;
  log: ServerEvent[];
}
