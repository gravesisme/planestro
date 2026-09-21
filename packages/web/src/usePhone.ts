import { useSyncExternalStore } from 'react';

/** The same width the phone block in styles.css switches on: where the layout, not just the styling, differs. */
const QUERY = '(max-width: 840px)';
const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(QUERY) : undefined;
const subscribe = (fn: () => void) => { mq?.addEventListener('change', fn); return () => mq?.removeEventListener('change', fn); };

export function usePhone(): boolean {
  return useSyncExternalStore(subscribe, () => mq?.matches ?? false, () => false);
}
