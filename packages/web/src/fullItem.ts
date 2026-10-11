import { useEffect, useState } from 'react';
import { api, type ItemView } from './api.ts';
import { useStore } from './store.ts';

/**
 * An item as the page draws it. /api/state lists a done or iceboxed item as a summary (`summary: true`), so its full view
 * (Plan, every Activity line) is asked for here, again whenever the listed one changes; the summary stands in meanwhile.
 */
export function useFullItem(id: string | undefined): ItemView | undefined {
  const listed = useStore((s) => (id ? s.state?.items.find((i) => i.id === id) : undefined));
  const [full, setFull] = useState<ItemView>();
  useEffect(() => {
    if (!id || !listed?.summary) return;
    let live = true;
    api.item(id).then((v) => { if (live) setFull(v); }).catch(() => { /* the summary stays */ });
    return () => { live = false; };
  }, [id, listed]);
  return listed?.summary && full?.id === id ? full : listed;
}
