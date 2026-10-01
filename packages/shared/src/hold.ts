// ---- a merge hold stated in a plan's text (#97) ----

/**
 * The sentence of a plan that says its pull request must wait, and what it waits for. Never
 * persisted: it is read from the plan as it stands, so a plan edited by hand is judged as it reads now.
 */
export interface HoldFlag { quote: string; reason: string }

const OBJ = '(?:(?:this|the|its|that)(?:\\s+(?:PR|pull\\s+request|branch|change|item|work))?|it|PR\\s*#?\\d*)';
const SUBJ = '(?:(?:this|the|its|that)\\s+)?(?:PR|pull\\s+request|merge|branch)(?:\\s+(?:#\\d+|\\(#\\d+\\)))?';
const WEAK = '(?:it|this(?:\\s+(?:change|item|work|one))?)';
const STATE = '(?:held|on\\s+hold|unmerged|(?:as\\s+|in\\s+)?(?:a\\s+)?draft)';
const UNTIL = '(?:until|till|pending|unless)';
const MODAL = '(?:should|must|will|can|may|is\\s+to|has\\s+to|needs\\s+to)';

/**
 * How a sentence states a hold. `tail`: the pattern ends on the word the wait starts with ("until",
 * "before", "after"), and the reason is the sentence from there. `label`: "Merge hold: …", the reason
 * is what follows the label. `whole`: the sentence is the reason.
 */
const PATTERNS: { re: RegExp; reason: 'tail' | 'label' | 'whole' }[] = [
  // "do not merge [this PR] [into X] until …", "must not be merged before …"
  { re: new RegExp(`\\b(?:do\\s+not|don['’]?t|must\\s+not|should\\s+not|shouldn['’]?t|may\\s+not|cannot|can['’]?t|never|not\\s+to)\\s+(?:be\\s+)?(?:auto-?)?merged?(?:\\s+${OBJ})?(?:\\s+(?:in)?to\\s+\\S+)?\\s+(until|till|before|unless|without)\\b`, 'i'), reason: 'tail' },
  // "the PR stays held until …"; a bare "it is held until …" is about anything, so "it"/"this" need stays/remains
  { re: new RegExp(`\\b(?:${SUBJ}\\s+(?:stays?|remains?|is|(?:is|gets?)\\s+kept|${MODAL}\\s+(?:stay|remain|be(?:\\s+kept)?))|${WEAK}\\s+(?:stays?|remains?|${MODAL}\\s+(?:stay|remain)))\\s+${STATE}\\s+(${UNTIL})\\b`, 'i'), reason: 'tail' },
  // "hold the PR until …", "keep the pull request as a draft until …"
  { re: new RegExp(`\\b(?:hold|keep)\\s+${SUBJ}(?:\\s+${STATE}|\\s+open|\\s+back)?\\s+(${UNTIL})\\b`, 'i'), reason: 'tail' },
  { re: /\bhold\s+off\s+(?:on\s+)?(?:the\s+)?merg(?:e|ing)\b[^.\n]{0,40}?\b(until|till|pending|unless)\b/i, reason: 'tail' },
  // "merge only after …", "the PR merges only once …"
  { re: /^(?:only\s+merge|merge\s+only)\s+(after|once|when)\b/i, reason: 'tail' },
  { re: new RegExp(`\\b(?:${SUBJ}|${WEAK})\\s+(?:${MODAL}\\s+)?(?:only\\s+be\\s+merged|be\\s+merged\\s+only|only\\s+merges?|merges?\\s+only|is\\s+(?:only\\s+merged|merged\\s+only))\\s+(after|once|when)\\b`, 'i'), reason: 'tail' },
  { re: /\bskip_merge\b[^.\n]{0,40}?\b(until|till|pending)\b/i, reason: 'tail' },
  // a sentence that opens with it: "Held until the store listing is approved."
  { re: new RegExp(`^(?:held|on\\s+hold)\\s+(${UNTIL})\\b`, 'i'), reason: 'tail' },
  { re: /^(?:merge\s+hold|hold)\s*[:—-]\s*(\S)/i, reason: 'label' },
  // "needs the designer's sign-off before merging": a need, someone's say-so, and the merge
  { re: /^(?=.*\b(?:needs?|requires?|must\s+have|wait(?:s|ing)?\s+for|(?:is|are)\s+(?:needed|required))\b)(?=.*\b(?:review|sign[- ]?off|approval|go-ahead)\b).*\b(before)\s+(?:merging|(?:it|this|the\s+(?:PR|pull\s+request))\s+(?:is\s+)?merge[sd]?|the\s+merge)(?=\s*(?:$|[.,;:!?)]))/i, reason: 'whole' },
];

/** The word a wait starts with, in the one form the item shows: "held: until …". */
const asUntil = (tail: string) => tail.replace(/^(?:till|before|after|once|when)\b/i, 'until');
const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
/** Emphasis and code marks go; an underscore inside a word (skip_merge) stays. */
const unmarked = (s: string) => s.replace(/[*`]/g, '').replace(/(^|[^\w])_+(?=\w)/g, '$1').replace(/(\w)_+(?=[^\w]|$)/g, '$1');
const isSeparator = (row: string) => /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(row.trim());

/** The plan as sentences: fenced code left out, list, heading and quote marks dropped, a table row read cell by cell. */
function sentencesOf(plan: string): string[] {
  const out: string[] = [];
  let fence: string | undefined;
  for (const raw of plan.split('\n')) {
    const f = /^\s*(```|~~~)/.exec(raw);
    if (f) { fence = fence === undefined ? f[1] : fence === f[1] ? undefined : fence; continue; }
    if (fence !== undefined) continue;
    const line = raw.replace(/^\s*(?:>\s*)*/, '').replace(/^(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '');
    const parts = /^\s*\|/.test(line) ? (isSeparator(line) ? [] : line.trim().replace(/^\||\|$/g, '').split('|')) : [line];
    for (const part of parts) for (const s of unmarked(part).split(/(?<=[.!?])\s+/)) if (s.trim()) out.push(s.trim());
  }
  return out;
}

/**
 * Whether a plan says its pull request must wait before it merges, and for what; null when it does
 * not. Code decides this, not a model (invariant 4). LM-22's plan said "PR stays held until …" and
 * nothing held it. The check is narrow on purpose: a sentence has to name the merge or the pull
 * request and the wait ("do not merge until", "the PR stays held until", "merge only after",
 * "Merge hold: …"). Holding a lock, merging two arrays and running the tests before merging are not
 * holds. What it misses, the worker can still say with report_done's `hold`.
 */
export function holdShapeOf(plan: string): HoldFlag | null {
  for (const sentence of sentencesOf(plan)) {
    for (const { re, reason } of PATTERNS) {
      const m = re.exec(sentence);
      if (!m) continue;
      const stated = (reason === 'whole' ? sentence
        : reason === 'label' ? sentence.slice(m.index + m[0].length - 1)
          : asUntil(sentence.slice(m.index + m[0].length - m[1].length))).replace(/[\s.;,!]+$/, '').trim();
      if (!stated) continue;
      return { quote: cap(sentence, 300), reason: cap(stated, 200) };
    }
  }
  return null;
}

/** Why the item is held, while it is: a reason left behind by a hold that has gone is not shown. */
export function heldReasonOf(fm: { skip_merge?: boolean; hold_reason?: string }): string | undefined {
  return fm.skip_merge ? fm.hold_reason?.trim() || undefined : undefined;
}

/** The preview deployment for an item's PR head, when one was found (#137): `op_data.preview`, read with the held poll. */
export function previewOf(fm: { op_data?: Record<string, unknown> }): { url: string; sha: string } | undefined {
  const p = fm.op_data?.preview as { url?: unknown; sha?: unknown } | undefined;
  return typeof p?.url === 'string' && /^https?:\/\//.test(p.url) && typeof p.sha === 'string' ? { url: p.url, sha: p.sha } : undefined;
}
