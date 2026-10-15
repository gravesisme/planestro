import type { JournalEntry } from './events.ts';
import { USAGE_TURN, type UsageTurn } from './usageLog.ts';

/**
 * Wasted test runs (#347). The engine journals one `test.run` per worker command that matched `test_runs.patterns`
 * (a Bash call that ran, or a run_heavy batch), with the worktree's tree (tracked and untracked files, ignored ones
 * left out) when it ended. What counts as waste is read from those entries, never asked of a model:
 * - a whole-suite run: a test command with no names after it and none of `test_runs.filters`;
 * - a repeat: the same command again on a tree unchanged since its last green run;
 * - a load repeat: a load pass (`test_runs.repeat_flags`) again on a tree unchanged since a green load pass.
 */
export const TEST_RUN = 'test.run';
export interface TestRunEntry {
  command: string;
  ok: boolean;
  ms: number;
  /** The worktree's tree when it ended; unset when it could not be read (then it is never a repeat). */
  tree?: string;
  whole_suite: boolean;
  load: boolean;
  source: 'bash' | 'run_heavy';
}

export interface TestRunConfig { patterns: string[]; filters: string[]; repeat_flags: string[] }

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
/** The command's simple commands: split at `&&`, `||`, `;` and pipes, redirections dropped. */
function segments(command: string): string[][] {
  return command.split(/&&|\|\||[;|\n]/).map((s) => words(s).filter((w) => !/^\d*[<>]/.test(w) && !/^&?>/.test(w))).filter((w) => w.length);
}

/** What kind of test run a command is, or undefined when it runs no tests (no pattern matched). */
export function testRunShape(command: string, cfg: TestRunConfig): { whole_suite: boolean; load: boolean } | undefined {
  for (const seg of segments(command)) {
    for (const p of cfg.patterns) {
      const pw = words(p.replace(/^Bash\((.*?)(?: \*)?\)$/, '$1'));
      if (!pw.length || seg.length < pw.length || pw.some((w, i) => seg[i] !== w)) continue;
      const rest = seg.slice(pw.length);
      // `npm test -- --shard 1/2`: a lone `--` passes the rest along and narrows nothing by itself.
      const args = rest.filter((w) => w !== '--');
      const flag = (list: string[]) => args.some((a) => list.some((f) => a === f || a.startsWith(`${f}=`)));
      // A bare word is a test name, unless it is a narrowing or load flag's value (`--shard 1/2`, `--repeat 5`).
      const named = args.some((a, i) => !a.startsWith('-') && !(i > 0 && [...cfg.filters, ...cfg.repeat_flags].includes(args[i - 1])));
      return { whole_suite: !named && !flag(cfg.filters), load: flag(cfg.repeat_flags) };
    }
  }
  return undefined;
}

export interface WasteCount { runs: number; ms: number }
export interface TestWaste {
  runs: number;
  ms: number;
  /** The wasted runs, each once (a whole-suite run that also repeats is one). */
  wasted: WasteCount;
  whole_suite: WasteCount;
  repeats: WasteCount;
  load_repeats: WasteCount;
  /** What the turns that made a wasted run cost (each turn once): the cost they fell in, not their share of it. */
  turn_usd: number;
  turn_tokens: number;
}
export const emptyWaste = (): TestWaste => ({ runs: 0, ms: 0, wasted: { runs: 0, ms: 0 }, whole_suite: { runs: 0, ms: 0 }, repeats: { runs: 0, ms: 0 }, load_repeats: { runs: 0, ms: 0 }, turn_usd: 0, turn_tokens: 0 });

/** Each item's test runs and their waste, from the entries in order. A run falls in the item's next `usage.turn`. */
export function testWaste(entries: JournalEntry[]): Map<string, TestWaste> {
  const out = new Map<string, TestWaste>();
  const greens = new Map<string, Map<string, string>>(); // item → command → tree of its last green run
  const greenLoad = new Map<string, Set<string>>();       // item → trees with a green load pass
  const pending = new Map<string, boolean>();              // item → its current turn made a wasted run
  for (const e of entries) {
    if (!e.item) continue;
    if (e.type === USAGE_TURN) {
      if (pending.get(e.item)) { const w = out.get(e.item)!; const u = e.data as unknown as UsageTurn; w.turn_usd += u.usd ?? 0; w.turn_tokens += u.tokens ?? 0; }
      pending.delete(e.item);
      continue;
    }
    if (e.type !== TEST_RUN) continue;
    const r = e.data as unknown as TestRunEntry;
    const w = out.get(e.item) ?? emptyWaste(); out.set(e.item, w);
    const ms = Math.max(0, Number(r.ms) || 0);
    w.runs += 1; w.ms += ms;
    const g = greens.get(e.item) ?? new Map<string, string>(); greens.set(e.item, g);
    const loads = greenLoad.get(e.item) ?? new Set<string>(); greenLoad.set(e.item, loads);
    let wasted = false;
    if (r.whole_suite) { w.whole_suite.runs += 1; w.whole_suite.ms += ms; wasted = true; }
    if (r.tree && r.load && loads.has(r.tree)) { w.load_repeats.runs += 1; w.load_repeats.ms += ms; wasted = true; }
    else if (r.tree && g.get(r.command) === r.tree) { w.repeats.runs += 1; w.repeats.ms += ms; wasted = true; }
    if (r.ok && r.tree) { g.set(r.command, r.tree); if (r.load) loads.add(r.tree); }
    if (wasted) { w.wasted.runs += 1; w.wasted.ms += ms; pending.set(e.item, true); }
  }
  for (const w of out.values()) w.turn_usd = Math.round(w.turn_usd * 100) / 100;
  return out;
}
