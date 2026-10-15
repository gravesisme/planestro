import { useEffect, useState, type RefObject } from 'react';
import { land } from '../deepLink.ts';

/** One place on the item page the nav jumps to. */
export interface NavEntry { id: string; label: string; wait: boolean }

/** What a waiting panel is called in the nav, by its id (#226): the panel a person answers. */
const WAIT_NAV: Record<string, string> = {
  plan: 'Plan needs your approval', breakdown: 'Breakdown needs your approval', permission: 'Permission requested', question: 'The agent asked',
  audition: 'Takes to pick', review: 'Waiting for your review', decision: 'Your decision', blocked: 'Blocked', hold: 'Held out of the merge queue',
};

interface Root { querySelectorAll(sel: string): ArrayLike<Element> | Iterable<Element> }

/**
 * The page's sections as the nav lists them (#374): every panel waiting on you first, then each section the page
 * rendered, in page order. A section names itself with `data-nav` (its label, with a count where it helps) and an `id`,
 * so `/items/X#attachments` is a link too; a waiting panel needs only its `data-wait` and id.
 */
export function navEntries(root: Root): NavEntry[] {
  const all = [...root.querySelectorAll('[data-wait][id], [data-nav][id]') as Iterable<Element>].map((el) => {
    const wait = el.hasAttribute('data-wait');
    return { id: el.id, label: (wait ? WAIT_NAV[el.id] : undefined) ?? el.getAttribute('data-nav') ?? el.id, wait };
  });
  return [...all.filter((e) => e.wait), ...all.filter((e) => !e.wait)];
}

/** The entries of the page under `root`, kept current as sections come and go (a panel answered, a count that changed). */
function useNavEntries(root: RefObject<HTMLElement | null>): NavEntry[] {
  const [entries, setEntries] = useState<NavEntry[]>([]);
  useEffect(() => {
    const el = root.current; if (!el) return;
    let last = '';
    const read = () => { const next = navEntries(el); const key = JSON.stringify(next); if (key !== last) { last = key; setEntries(next); } };
    read();
    const watch = new MutationObserver(read);
    watch.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ['id', 'data-nav', 'data-wait'] });
    return () => watch.disconnect();
  }, [root]);
  return entries;
}

const go = (id: string) => { const el = document.getElementById(id); if (el) { land(el); history.replaceState(history.state, '', `#${id}`); } };

/**
 * A long item page's sections, one click away from anywhere on it (#374): a sticky list under the item's details on a
 * wide screen, a "Jump to…" select at the top on a phone. Waiting panels come first and are marked.
 */
export function SectionNav({ root, variant }: { root: RefObject<HTMLElement | null>; variant: 'list' | 'select' }) {
  const entries = useNavEntries(root);
  if (entries.length < 2) return null;
  if (variant === 'select') return (
    <select className="section-jump phone-only" aria-label="Jump to a section" value="" onChange={(e) => { if (e.target.value) go(e.target.value); }}>
      <option value="">Jump to…</option>
      {entries.map((e) => <option key={e.id} value={e.id}>{e.wait ? `● ${e.label}` : e.label}</option>)}
    </select>
  );
  return (
    <nav className="section-nav desk-only" aria-label="Sections of this item">
      {entries.map((e) => <a key={e.id} href={`#${e.id}`} className={e.wait ? 'wait' : undefined} onClick={(ev) => { ev.preventDefault(); go(e.id); }}>{e.label}</a>)}
    </nav>
  );
}
