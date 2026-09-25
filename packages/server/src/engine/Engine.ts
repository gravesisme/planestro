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
  approvePlan(id: string, notes?: string): Promise<void>;
  rejectPlan(id: string, message: string): Promise<void>;
  message(id: string, text: string): Promise<void>;
  respond(id: string, payload: Record<string, unknown>): Promise<void>;
  /** Have the planner propose an epic's children. */
  planEpic(id: string): Promise<void>;
  /** Create the children (as the user edited them), open the epic and queue what can start. Returns the new ids. */
  approveBreakdown(id: string, children?: BreakdownChild[], opts?: { queue?: boolean }): Promise<string[]>;
  reviewImages(id: string): Promise<ReviewImage[]>;
  reviewImage(id: string, path: string, side: 'before' | 'after'): Promise<Buffer | null>;
  requestReviewChanges(id: string, note: string): Promise<void>;
  /** Let a held pull request (a review hold, or skip_merge) back into the merge pipeline. */
  releaseHold(id: string, note?: string): Promise<void>;
  /** Finish an item without a pull request: the work landed some other way. User-only. */
  closeAsDone(id: string, reason?: string): Promise<void>;
  /** A person finishes the item by hand: its live turn is stopped, what was queued for it is dropped, and nothing automatic drives it until handBack. User-only. */
  takeOver(id: string, note?: string): Promise<void>;
  /** The person is done with it: planestro carries on from the item's persisted state. */
  handBack(id: string, note?: string): Promise<void>;
  sessions(): SessionView[];
  /** Getting ready for a restart: nothing new starts until undrain (or the restart). Engines without automation leave these out. */
  drain?(): void;
  undrain?(): void;
  restartReadiness?(): { draining: boolean; idle: boolean; running: string[] };
  log: ServerEvent[];
}
