import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { api, type ReviewDiff, type ReviewImage } from '../api.ts';
import { parsePatch, splitRows, lineKey, quoteLines, type DiffLine } from '../diff.ts';

type Hljs = typeof import('highlight.js/lib/common').default;
let hljs: Promise<Hljs> | undefined;
/** The highlighter loads with the first diff opened, so the board and pages that show none do not carry it. */
const loadHljs = () => (hljs ??= import('highlight.js/lib/common').then((m) => m.default));
const ALIAS: Record<string, string> = { gd: 'python', tscn: 'ini', tres: 'ini', godot: 'ini', mjs: 'javascript', cjs: 'javascript', jsonc: 'json', toml: 'ini' };
const langOf = (h: Hljs, path: string) => { const ext = (path.split('/').pop()!.split('.').pop() ?? '').toLowerCase(); const l = ALIAS[ext] ?? ext; return h.getLanguage(l) ? l : undefined; };
/** A diff past this many lines opens folded: a generated file or a lockfile should not bury the rest. */
const LARGE = 400;

/**
 * One text file of the review panel, opened to its diff against the base (#233): unified or side by side, highlighted
 * line by line. With `onQuote`, picking line numbers (shift for a range) sends those lines to the review note.
 */
export function FileDiff({ itemId, file, v, split, onQuote }: { itemId: string; file: ReviewImage; v: string; split: boolean; onQuote?: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<ReviewDiff | 'error' | null>(null);
  const [showLarge, setShowLarge] = useState(false);
  const [h, setH] = useState<Hljs | null>(null);
  const [sel, setSel] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<number | null>(null);
  useEffect(() => { setDiff(null); setSel([]); }, [v]);
  useEffect(() => {
    if (!open || diff) return;
    let live = true;
    api.reviewDiff(itemId, file.path).then((d) => { if (live) setDiff(d); }).catch(() => { if (live) setDiff('error'); });
    return () => { live = false; };
  }, [open, diff, itemId, file.path]);
  useEffect(() => { if (open && !h) void loadHljs().then((x) => setH(() => x)).catch(() => undefined); }, [open, h]);
  const hunks = useMemo(() => diff && diff !== 'error' ? parsePatch(diff.patch) : [], [diff]);
  const all = useMemo(() => hunks.flatMap((x) => x.lines), [hunks]);
  const lang = h ? langOf(h, file.path) : undefined;
  const code = (text: string) => lang && h ? <span dangerouslySetInnerHTML={{ __html: h.highlight(text, { language: lang, ignoreIllegals: true }).value || ' ' }} /> : (text || ' ');
  const pick = (l: DiffLine, e: MouseEvent) => {
    if (!onQuote) return;
    const i = all.indexOf(l);
    if (e.shiftKey && anchor !== null) { const [a, b] = anchor < i ? [anchor, i] : [i, anchor]; setSel(all.slice(a, b + 1).map(lineKey)); return; }
    const k = lineKey(l);
    setAnchor(i);
    setSel((s) => s.length === 1 && s[0] === k ? [] : [k]);
  };
  const chosen = all.filter((l) => sel.includes(lineKey(l)));
  const num = (l: DiffLine | undefined, side: 'old' | 'new') => (
    <td className={`diff-num${onQuote && l ? ' pickable' : ''}`} onClick={l ? (e) => pick(l, e) : undefined} title={onQuote && l ? 'Pick this line (shift: a range) to quote it in your review' : undefined}>{l?.[side] ?? ''}</td>
  );
  const cls = (l: DiffLine | undefined) => `diff-code ${l ? `diff-${l.type}` : 'diff-empty'}${l && sel.includes(lineKey(l)) ? ' picked' : ''}`;
  const sign = (l: DiffLine | undefined) => !l ? '' : l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
  const body = () => {
    if (diff === null) return <p className="small muted row"><span className="spinner" aria-hidden="true" /> Reading the diff…</p>;
    if (diff === 'error') return <p className="small muted">Could not read this diff.</p>;
    if (diff.binary) return <p className="small muted">A binary file: no text diff.</p>;
    if (!hunks.length) return <p className="small muted">No line changes (a mode change, or an empty file).</p>;
    if (all.length > LARGE && !showLarge) return <p className="small muted">A large diff ({all.length} lines). <button className="small" onClick={() => setShowLarge(true)}>Show it</button></p>;
    return (
      <div className="diff-scroll">
        <table className={`diff ${split ? 'split' : 'unified'}`}>
          {split && <colgroup><col className="diff-numcol" /><col /><col className="diff-numcol" /><col /></colgroup>}
          <tbody>
            {hunks.map((hk, i) => [
              <tr key={`h${i}`} className="diff-hunk"><td colSpan={split ? 4 : 3}>{hk.header}</td></tr>,
              ...(split ? splitRows(hk.lines).map((r, j) => (
                <tr key={`${i}-${j}`}>
                  {num(r.left, 'old')}<td className={cls(r.left)} data-sign={sign(r.left)}>{r.left ? code(r.left.text) : ''}</td>
                  {num(r.right, 'new')}<td className={cls(r.right)} data-sign={sign(r.right)}>{r.right ? code(r.right.text) : ''}</td>
                </tr>
              )) : hk.lines.map((l) => (
                <tr key={`${i}-${lineKey(l)}`}>
                  {num(l, 'old')}{num(l, 'new')}<td className={cls(l)} data-sign={sign(l)}>{code(l.text)}</td>
                </tr>
              ))),
            ])}
          </tbody>
        </table>
        {diff.truncated && <p className="small muted">The diff is cut here: it is over a megabyte.</p>}
      </div>
    );
  };
  return (
    <div className="review-card diff-card">
      <button type="button" className="diff-toggle small" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span><span aria-hidden="true">{open ? '▾' : '▸'}</span> <code>{file.path}</code></span> <span className={`tag ${file.change === 'added' ? 'ok' : file.change === 'deleted' ? 'hot' : ''}`}>{file.change}</span>
      </button>
      {open && body()}
      {open && onQuote && chosen.length > 0 && (
        <div className="row" style={{ marginTop: 6 }}>
          <span className="small muted">{chosen.length} line{chosen.length === 1 ? '' : 's'} picked</span>
          <span className="grow" />
          <button className="small" onClick={() => setSel([])}>Clear</button>
          <button className="small primary" onClick={() => { onQuote(quoteLines(file.path, chosen)); setSel([]); }}>Send as review feedback</button>
        </div>
      )}
    </div>
  );
}
