import net from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { getSystemErrorName } from 'node:util';

// ---- the port stays open across a --watch restart (#354) ----
// supervise() used to stop the old server child and start a new one, which bound the port again after
// its startup. A request in that gap was refused, and Claude Code marks an MCP server that refuses
// once as failed for good: an interactive session lost planestro's tools until a manual reconnect.
// Now the supervisor binds the port and hands the socket to each child over IPC. Once a child has
// listened on it, the socket stays listening while the supervisor holds it, so a connection that
// arrives between two children waits in the kernel's backlog for the next one instead of being refused.

/** Set on a child the supervisor will hand a port to; a child started any other way binds its own. */
export const PORT_HANDOFF_ENV = 'PLANESTRO_PORT_HANDOFF';
const WANT = 'planestro:port?';
const GIVE = 'planestro:port';

export interface HeldPort { host: string; port: number; handle: unknown; close(): void }
export interface HandedPort { host: string; port: number; handle: unknown }

type ServerHandle = { getsockname(out: { port?: number }): number; close(): void };
const createServerHandle = (net as unknown as { _createServerHandle?: (address: string, port: number, addressType: number, fd?: number, flags?: number) => ServerHandle | number })._createServerHandle;

/**
 * Bind `host:port` without listening or accepting (what cluster's shared handles do): the supervisor
 * only keeps the socket alive. The first child's listen() puts it in the listening state, which lasts
 * as long as any process holds it. An address that is not an IP, or a bind that fails, is said in
 * words; the child then binds the port itself, as before.
 */
export function holdPort(host: string, port: number): HeldPort | { error: string } {
  const family = net.isIP(host);
  if (!family) return { error: `${host} is not an IP address` };
  if (typeof createServerHandle !== 'function') return { error: 'this Node cannot bind a port for a child' };
  const handle = createServerHandle(host, port, family);
  if (typeof handle === 'number') return { error: `bind ${host}:${port} failed (${errnoName(handle)})` };
  const out: { port?: number } = {};
  handle.getsockname(out);
  let closed = false;
  return { host, port: out.port ?? port, handle, close: () => { if (!closed) { closed = true; handle.close(); } } };
}

function errnoName(code: number): string {
  try { return getSystemErrorName(code); } catch { return String(code); }
}

/** The supervisor's side: answer the child's request with the socket. A child gone mid-send is its exit's business. */
export function offerPort(child: ChildProcess, held: HeldPort): void {
  child.on('message', (m) => {
    if ((m as { type?: unknown } | null)?.type !== WANT || !child.connected) return;
    try { child.send({ type: GIVE, host: held.host, port: held.port }, held.handle as never); } catch { /* exited */ }
  });
}

/**
 * The child's side: ask a supervisor that said it would hand a port over for it. Asking (rather than
 * waiting for a message sent at spawn) cannot lose it to a listener not yet attached. Anything else —
 * no supervisor, an older one with no IPC channel, no answer in time — is undefined: bind as before.
 */
export function receivePort(timeoutMs = 10_000, proc: NodeJS.Process = process): Promise<HandedPort | undefined> {
  if (proc.env[PORT_HANDOFF_ENV] !== '1' || typeof proc.send !== 'function') return Promise.resolve(undefined);
  return new Promise((done) => {
    const finish = (r: HandedPort | undefined) => { clearTimeout(timer); proc.off('message', onMessage); proc.channel?.unref(); done(r); };
    const onMessage = (m: unknown, handle: unknown) => {
      const msg = m as { type?: unknown; host?: unknown; port?: unknown } | null;
      if (msg?.type !== GIVE || !handle || typeof msg.host !== 'string' || typeof msg.port !== 'number') return;
      finish({ host: msg.host, port: msg.port, handle });
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    proc.on('message', onMessage);
    proc.send!({ type: WANT });
  });
}
