import { Component, type ReactNode } from 'react';

/** What a render error left (#280): the error and a way back, instead of a blank page with nothing to go on. */
export function CrashScreen({ error }: { error: Error }) {
  return (
    <div className="crash" role="alert">
      <h2>planestro hit an error</h2>
      <p className="muted small">The page could not be drawn. Reloading usually brings it back; if it keeps happening, this is what failed:</p>
      <pre className="events">{`${error.name}: ${error.message}`}</pre>
      <button className="primary" onClick={() => location.reload()}>Reload</button>
    </div>
  );
}

/** Any error while rendering unmounted the whole app, which left only the background colour. */
export class CrashBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error : new Error(String(error)) }; }
  componentDidCatch(error: unknown) { console.error('planestro render error', error); }
  render() { return this.state.error ? <CrashScreen error={this.state.error} /> : this.props.children; }
}
