import type { Context, MiddlewareHandler } from 'hono';
import { isIPv4, isIPv6 } from 'node:net';
import { hostname as osHostname, networkInterfaces } from 'node:os';
import type { LocalConfig } from '@planestro/shared';

/** Where the server listens: `--host` when given, else every interface with `lan_access` (#255), else loopback. */
export function bindHost(flag: string | undefined, local: Pick<LocalConfig, 'lan_access'>): string {
  return flag ?? (local.lan_access ? '0.0.0.0' : '127.0.0.1');
}

/**
 * Loopback, RFC 1918, link-local and IPv6 ULA (#255): where a phone on the same Wi-Fi comes from. There is
 * no login (#221), so with `lan_access` this is the lock: a port-forward or a public address is refused.
 */
export function isLanAddress(address: string): boolean {
  let a = address.trim().toLowerCase().replace(/%.*$/, '');
  if (a.startsWith('::ffff:') && isIPv4(a.slice(7))) a = a.slice(7);
  if (isIPv4(a)) {
    const [x, y] = a.split('.').map(Number);
    // 100.64.0.0/10 is carrier-grade NAT, which is where Tailscale hands out addresses (SECURITY.md recommends it).
    return x === 127 || x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254) || (x === 100 && y >= 64 && y <= 127);
  }
  if (!isIPv6(a)) return false;
  if (a === '::1') return true;
  const first = a.startsWith('::') ? 0 : parseInt(a.split(':')[0], 16);
  return (first & 0xffc0) === 0xfe80 || (first & 0xfe00) === 0xfc00;
}

/** A bind that only this machine can reach. Anything else answers only the local network (`lanOnly`), whatever lan_access says. */
export function isLoopbackBind(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === 'localhost' || h === '::1' || h.startsWith('127.');
}

/** Why a link to this URL would get a 403 from the guard, or undefined when the guard lets its Host in. */
export function linkRefusal(url: string, hosts: ReadonlySet<string>): string | undefined {
  let name: string;
  try { name = hostnameOf(new URL(url).host); } catch { return `${url} is not a URL`; }
  return hosts.has(name) ? undefined : `${name} is not one of this machine's names, so a link to ${url} gets a 403: add it to allowed_hosts in planestro.local.yml, or change notifications.base_url`;
}

/**
 * A request from this machine: a loopback peer, or an in-process one with no socket. What a setting
 * runs (a command, a program, an MCP server) is changed only from here, never from a phone on the LAN.
 */
export function fromThisMachine(c: Context): boolean {
  const peer = remoteAddress(c);
  if (peer === undefined) return true;
  const a = peer.trim().toLowerCase().replace(/^::ffff:/, '');
  return a === '::1' || a.startsWith('127.');
}

/** The peer's address on the node server; undefined where there is no socket (an in-process request). */
function remoteAddress(c: Context): string | undefined {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } }; server?: { incoming?: { socket?: { remoteAddress?: string } } } } | undefined;
  return (env?.server ?? env)?.incoming?.socket?.remoteAddress;
}

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

/**
 * The UI is served by this server, so its requests carry an Origin naming the Host they are sent to
 * (the Vite dev proxy keeps both at :5173). A hostname match alone would let a page on any other
 * localhost port in: the port is compared too.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);
const originHostname = (origin: string) => { try { return hostnameOf(new URL(origin).host); } catch { return ''; } };

export function sameOrigin(origin: string, host: string): boolean {
  let u: URL;
  try { u = new URL(origin); } catch { return false; }   // "null" or garbage
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const port = (h: string, def: string) => { const m = /:(\d+)$/.exec(h.replace(/^\[[^\]]*\]/, '')); return m ? m[1] : def; };
  const def = u.protocol === 'https:' ? '443' : '80';
  return hostnameOf(u.host) === hostnameOf(host) && port(u.host, def) === port(host.trim().toLowerCase(), def);
}

/** `lanOnly` (with `lan_access`, #255): also refuse a peer outside the local network, and one whose address is unknown. */
export function requestGuard(hosts: ReadonlySet<string>, log?: (level: 'warn', msg: string) => void, o: { lanOnly?: boolean; declared?: readonly string[] } = {}): MiddlewareHandler {
  // A name the user put in allowed_hosts is trusted as an Origin on any port (a proxy in front may rewrite Host); loopback never is.
  const declared = new Set((o.declared ?? []).map((h) => h.toLowerCase()).filter((h) => !LOOPBACK.has(h)));
  return async (c, next) => {
    const refuse = (why: string) => { log?.('warn', `refused ${c.req.method} ${c.req.path}: ${why}`); return c.json({ error: `planestro only answers its own UI (${why})` }, 403); };
    if (o.lanOnly) {
      const peer = remoteAddress(c);
      if (!peer || !isLanAddress(peer)) return refuse(`request from ${peer ?? 'an unknown address'}, outside the local network (lan_access answers only the LAN)`);
    }
    const host = c.req.header('host');
    if (!host || !hosts.has(hostnameOf(host))) return refuse(`unexpected Host ${host ?? '(none)'}; add it to allowed_hosts in planestro.local.yml if it is this machine`);
    const site = c.req.header('sec-fetch-site');
    const safe = c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS';
    if (site === 'cross-site') return refuse('cross-site request');
    // Another port on this machine is "same-site" to the browser: a dev server or a page a worker just built.
    if (site === 'same-site' && !safe) return refuse('request from another site on this machine');
    const origin = c.req.header('origin');
    if (origin !== undefined && !sameOrigin(origin, host) && !declared.has(originHostname(origin))) return refuse(`request from ${origin}`);
    // A form or text/plain body skips the CORS preflight; the UI only ever sends JSON or a multipart upload.
    if (!safe && /^\s*(text\/plain|application\/x-www-form-urlencoded)/i.test(c.req.header('content-type') ?? '')) return refuse('a form or text/plain body');
    await next();
  };
}
