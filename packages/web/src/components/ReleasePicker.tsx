import { openReleases } from '@planestro/shared';
import { useStore } from '../store.ts';

/**
 * The release an item is planned for (#375): the open ones (planned, submitted) and none. A value that is no longer
 * open (shipped, cancelled, renamed away) stays listed as it is, so looking never changes it.
 */
export function ReleasePicker({ value, onChange, title }: { value?: string; onChange: (release: string | null) => void; title?: string }) {
  const releases = useStore((s) => s.state?.releases) ?? [];
  const open = openReleases(releases).map((r) => r.version);
  const stale = value && !open.includes(value) ? value : undefined;
  const status = stale ? releases.find((r) => r.version === stale)?.frontmatter.status ?? 'no such release' : undefined;
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} title={title ?? 'The release this is planned for: planning only, nothing in the engine reads it'}>
      <option value="">none</option>
      {open.map((v) => <option key={v} value={v}>{v}</option>)}
      {stale && <option value={stale}>{stale} ({status})</option>}
    </select>
  );
}
