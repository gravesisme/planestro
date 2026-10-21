/**
 * planestro's own repository, named once: the Console's **Report to planestro** link, the data dir README and the docs
 * links the pages carry. The root package.json's `repository` / `homepage` / `bugs` name the same one (a test holds them).
 */
export const PLANESTRO_REPO = 'gravesisme/planestro';
export const PLANESTRO_REPO_URL = `https://github.com/${PLANESTRO_REPO}`;
/** Longest new-issue link offered: GitHub and browsers refuse much past 8k, so the body gives way first. */
export const REPORT_URL_MAX = 7500;
export const REPORT_TRUNCATED = '…(truncated; the full note is in your Console)';

/** An orchestrator note's issue title: its first sentence (at most 90 characters), led by its item unless it names it. */
export function noteTitle(item: string | undefined, text: string): string {
  const first = text.trim().split(/\n|(?<=[.!?])\s/)[0].trim();
  const short = first.length > 90 ? `${first.slice(0, 89).trimEnd()}…` : first;
  return item && !short.includes(item) ? `${item}: ${short}` : short;
}

/**
 * The human-reviewed path for a note about planestro while `feedback.issue_repo` is unset: GitHub's new-issue page on
 * planestro's repo, prefilled with the note's title and text and a footer naming the version. Nothing of the project goes
 * in that the note does not say itself (no project name, data dir or item id: the title is not led by the item), and the
 * person reviews and submits it there, so opening it records nothing. A body too long for `max` is cut at a code point and
 * ends with `REPORT_TRUNCATED`.
 */
export function reportIssueUrl(note: { text: string; version?: string }, max = REPORT_URL_MAX): string {
  const text = note.text.trim();
  const footer = `---\nReported from a planestro orchestrator note.${note.version ? ` Version: ${note.version}.` : ''}`;
  const url = (body: string) => `${PLANESTRO_REPO_URL}/issues/new?title=${encodeURIComponent(noteTitle(undefined, text))}&body=${encodeURIComponent(body)}`;
  const whole = url(`${text}\n\n${footer}`);
  if (whole.length <= max) return whole;
  const chars = Array.from(text);
  const cut = (n: number) => url(`${chars.slice(0, n).join('').trimEnd()}\n\n${REPORT_TRUNCATED}\n\n${footer}`);
  let lo = 0, hi = chars.length;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (cut(mid).length <= max) lo = mid; else hi = mid - 1; }
  return cut(lo);
}
