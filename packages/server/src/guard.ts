import type { MiddlewareHandler } from 'hono';
import { hostname as osHostname, networkInterfaces } from 'node:os';

/**
 * Binding to 127.0.0.1 keeps other machines out, not other websites: any page the user visits can
 * send requests to localhost, and a DNS-rebinding page can read the answers. The UI talks to its
 * own server, so everything else is refused: a Host that is not one of this machine's names, a
 * cross-site Sec-Fetch-Site, an Origin from somewhere else. This is not authentication — anyone who
 * can reach the port as this machine can still use it (see SECURITY.md).
 */
export function allowedHosts(bindHost: string, extra: readonly string[] = []): Set<string> {
  const hosts = new Set(['localhost', '127.0.0.1', '::1', ...extra.map((h) => h.toLowerCase())]);
  if (bindHost === '0.0.0.0' || bindHost === '::') {
    const name = osHostname().toLowerCase();
    for (const h of [name, name.replace(/\.local$/, ''), `${name.replace(/\.local$/, '')}.local`]) hosts.add(h);
    for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) hosts.add(a.address.toLowerCase());
  } else hosts.add(bindHost.toLowerCase());
  return hosts;
}

/** `example.com:4300` → `example.com`, `[::1]:4300` → `::1`. */
export function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'));
  return h.replace(/:\d+$/, '');
}

export function requestGuard(hosts: ReadonlySet<string>, log?: (level: 'warn', msg: string) => void): MiddlewareHandler {
  return async (c, next) => {
    const refuse = (why: string) => { log?.('warn', `refused ${c.req.method} ${c.req.path}: ${why}`); return c.json({ error: `planestro only answers its own UI (${why})` }, 403); };
    const host = c.req.header('host');
    if (!host || !hosts.has(hostnameOf(host))) return refuse(`unexpected Host ${host ?? '(none)'}; add it to allowed_hosts in planestro.local.yml if it is this machine`);
    if (c.req.header('sec-fetch-site') === 'cross-site') return refuse('cross-site request');
    const origin = c.req.header('origin');
    if (origin !== undefined) {
      let o: string | undefined;
      try { o = new URL(origin).hostname; } catch { /* "null" or garbage */ }
      if (!o || !hosts.has(hostnameOf(o))) return refuse(`request from ${origin}`);
    }
    await next();
  };
}
