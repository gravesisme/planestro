/** What a tapped answer or action shows while it goes out (#282, #304): it registered, and there is nothing to tap again. */
export function Sending({ label = 'Sending…' }: { label?: string }) {
  // An empty label (a × or a ☆ button) shows the spinner alone.
  return <span className="sending" role="status" aria-label={label ? undefined : 'Working'}><span className="spinner" aria-hidden="true" />{label ? ` ${label}` : null}</span>;
}
