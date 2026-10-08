import { useEffect } from 'react';
import { useLocation } from 'react-router';
import type { JournalEntry } from '@planestro/shared';

/**
 * Deep links that open straight to the decision (#226). A notification links `/items/:id#<kind>` (the server's wait
 * kind: plan, breakdown, permission, question, review, decision, blocked, hold, …) or `/questions/:id`. Every panel a
 * person answers carries `id="<kind>"` and `data-wait`, so the fragment is the element's id and a new kind needs only
 * its panel's id. A link whose wait has since changed lands on whatever the item waits for now, or stays at the top.
 */

/** Where a journaled notification opens in this tab: its link's path and fragment, else its item's page. */
export function notificationPath(e: Pick<JournalEntry, 'item' | 'data'>): string | undefined {
  const url = e.data?.url;
  if (typeof url === 'string' && url) {
    try { const u = new URL(url, 'http://planestro.invalid'); return `${u.pathname}${u.search}${u.hash}`; } catch { /* not a link: the item, below */ }
  }
  return e.item ? `/items/${encodeURIComponent(e.item)}` : undefined;
}

interface Root { getElementById(id: string): Element | null; querySelector(sel: string): Element | null }

/** The element a fragment names, else (`fallback`) the first panel waiting on you. */
export function waitTarget(root: Root, hash: string, fallback: boolean): Element | null {
  let id = hash.replace(/^#/, '');
  try { id = decodeURIComponent(id); } catch { /* as written */ }
  return (id ? root.getElementById(id) : null) ?? (fallback ? root.querySelector('[data-wait]') : null);
}

/** Scroll the target into view and focus it, without the focus scrolling it again. */
export function land(el: Element): void {
  const h = el as HTMLElement;
  if (!h.hasAttribute('tabindex') && h.tabIndex < 0) h.setAttribute('tabindex', '-1');
  const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  h.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  h.focus({ preventScroll: true });
}

/** Router state that asks a page to land on what it waits for when its link has no fragment (the "Needs you" button). */
export const TO_WAIT = { wait: true } as const;

/**
 * On each navigation to this page with a fragment (or TO_WAIT), land on its target once the page has rendered it.
 * A fragment that names nothing here falls back to the first panel waiting on you.
 */
export function useLandOnWait(): void {
  const { hash, key, state } = useLocation();
  const asked = Boolean(hash) || Boolean((state as { wait?: boolean } | null)?.wait);
  useEffect(() => {
    if (!asked) return;
    const el = waitTarget(document, hash, true);
    if (el) land(el);
  }, [key]); // once per navigation, not on every re-render
}
