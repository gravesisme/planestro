/** What a tapped answer shows while it goes out (#282): it registered, and there is nothing to tap again. */
export function Sending() {
  return <span className="sending" role="status"><span className="spinner" aria-hidden="true" /> Sending…</span>;
}
