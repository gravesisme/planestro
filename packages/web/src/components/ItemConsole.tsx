import { useEffect, useRef } from 'react';
import { api } from '../api.ts';
import { useStore } from '../store.ts';

/** Live per-item console: seeded from the server's ring buffer, appended over the WebSocket. */
export function ItemConsole({ id, tail, className }: { id: string; tail?: number; className?: string }) {
  const lines = useStore((s) => s.consoles[id]) ?? [];
  const seed = useStore((s) => s.seedConsole);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { void api.itemConsole(id).then((r) => { if (r.lines.length) seed(id, r.lines); }).catch(() => undefined); }, [id, seed]);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }); }, [lines.length]);
  const shown = tail ? lines.slice(-tail) : lines;
  return <div ref={ref} className={`events console ${className ?? ''}`}>{shown.length ? shown.join('\n') : 'No session output yet for this item.'}</div>;
}
