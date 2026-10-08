// ---- coming back to the installed app (#280) ----
// An iPhone Home Screen web app came back from the background to a black screen (the manifest's background colour,
// nothing rendered) until it was force-quit. Whatever left it so, a page that is visible with nothing in it reloads.

/** One recovery reload in this window at most, so a page that cannot render shows its blank page instead of looping. */
export const RELOAD_GUARD_MS = 30_000;
/** How long a page that has just become visible gets to paint before it counts as blank. */
export const BLANK_AFTER_MS = 1500;
const KEY = 'planestro.recovered_at';

type Listen = { addEventListener(type: string, f: (e: any) => void): void };
export interface ResumeDeps {
  win: Listen;
  doc: Listen & { hidden: boolean; getElementById(id: string): { childElementCount: number } | null };
  storage: { getItem(k: string): string | null; setItem(k: string, v: string): void };
  reload(): void;
  now(): number;
  later(f: () => void, ms: number): void;
}

/** Reload, unless this page already did so within RELOAD_GUARD_MS. Storage that throws (a private window) never blocks it. */
export function reloadOnce(d: Pick<ResumeDeps, 'storage' | 'reload' | 'now'>): boolean {
  let last = 0;
  try { last = Number(d.storage.getItem(KEY) ?? 0); } catch { /* no storage: reload anyway */ }
  if (d.now() - last < RELOAD_GUARD_MS) return false;
  try { d.storage.setItem(KEY, String(d.now())); } catch { /* as above */ }
  d.reload();
  return true;
}

/** A page restored from the back/forward cache reloads; a page shown with nothing rendered reloads once it has had time to paint. */
export function guardResume(d: ResumeDeps): void {
  d.win.addEventListener('pageshow', (e: { persisted?: boolean }) => { if (e.persisted) reloadOnce(d); });
  d.doc.addEventListener('visibilitychange', () => {
    if (d.doc.hidden) return;
    d.later(() => { if (!d.doc.hidden && !d.doc.getElementById('root')?.childElementCount) reloadOnce(d); }, BLANK_AFTER_MS);
  });
}
