import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { isoLocal, type LocalConfig } from '@planestro/shared';
import { fromThisMachine } from './guard.ts';

// ---- pairing (#403) ----
// A server reached from another machine (lan_access, --host) used to answer anyone on the local network. Now a
// request from anywhere but this machine carries a paired device's token; this machine needs none, exactly as before.
// A device pairs once: `planestro pair` (or Settings, on this machine) mints a one-time code, the device's /pair page
// trades it for a long-lived token, kept in an HttpOnly cookie (and shown once, for an MCP client's bearer header).
// Only the token's sha256 is stored, in planestro.local.yml; revoking a device removes it and its next request is refused.

export const TOKEN_COOKIE = 'planestro_token';
/** How long a minted code stays good, and how many wrong codes void every pending one. */
export const CODE_TTL_MS = 10 * 60_000;
export const MAX_FAILURES = 10;
const COOKIE_MAX_AGE_S = 400 * 24 * 3600;   // browsers cap cookies at 400 days
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no 0/O, 1/I/L

export type PairedDevice = NonNullable<LocalConfig['paired_devices']>[number];
export interface PairingStore { readonly local: LocalConfig; updateLocal(patch: Partial<LocalConfig>): LocalConfig }

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** `abcd-efgh`, `ABCDEFGH`, ` abcd efgh ` all read as the same code. */
export const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

export class Pairing {
  /** Pending codes by normalized value: in memory on purpose, so a restart voids them (a code is minutes old at most). */
  private codes = new Map<string, number>();
  private failures = 0;
  constructor(private store: PairingStore, private now: () => number = Date.now) {}

  /** A one-time code, good for CODE_TTL_MS. Only this machine may ask (the route checks). */
  mint(): { code: string; expires_at: string } {
    this.prune();
    let raw = '';
    for (let i = 0; i < 8; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
    const expires = this.now() + CODE_TTL_MS;
    this.codes.set(raw, expires);
    this.failures = 0;
    return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expires_at: new Date(expires).toISOString() };
  }

  /** Trade a code for a device token. A wrong code counts; MAX_FAILURES of them void every pending code. */
  redeem(code: string, name: string | undefined): { device: Omit<PairedDevice, 'token_sha256'>; token: string } | { error: string } {
    this.prune();
    const key = normalizeCode(code);
    if (!this.codes.has(key)) {
      if (++this.failures >= MAX_FAILURES && this.codes.size) { this.codes.clear(); return { error: 'too many wrong codes: every pending code is void; run planestro pair again' }; }
      return { error: 'that code is wrong or expired: run planestro pair on the machine running planestro for a new one' };
    }
    this.codes.delete(key);
    const token = randomBytes(32).toString('base64url');
    const device: PairedDevice = { id: randomBytes(6).toString('hex'), name: (name ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 80) || 'device', token_sha256: sha256(token), created_at: isoLocal(new Date(this.now())) };
    this.store.updateLocal({ paired_devices: [...(this.store.local.paired_devices ?? []), device] });
    const { token_sha256: _hash, ...shown } = device;
    return { device: shown, token };
  }

  /** The paired device a token belongs to, read from the file each time so a revocation applies to the next request. */
  check(token: string | undefined): PairedDevice | undefined {
    if (!token) return undefined;
    const hash = Buffer.from(sha256(token), 'hex');
    return (this.store.local.paired_devices ?? []).find((d) => { const h = Buffer.from(d.token_sha256, 'hex'); return h.length === hash.length && timingSafeEqual(h, hash); });
  }

  devices(): Omit<PairedDevice, 'token_sha256'>[] {
    return (this.store.local.paired_devices ?? []).map(({ token_sha256: _hash, ...d }) => d);
  }

  revoke(id: string): boolean {
    const list = this.store.local.paired_devices ?? [];
    if (!list.some((d) => d.id === id)) return false;
    this.store.updateLocal({ paired_devices: list.filter((d) => d.id !== id) });
    return true;
  }

  private prune(): void { const t = this.now(); for (const [k, exp] of this.codes) if (exp <= t) this.codes.delete(k); }
}

/** The token a request carries: `Authorization: Bearer` (an MCP client), else the pairing cookie (the browser). */
export function requestToken(c: Context): string | undefined {
  const auth = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header('authorization') ?? '')?.[1];
  if (auth) return auth;
  for (const part of (c.req.header('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === TOKEN_COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export function tokenCookie(token: string): string {
  return `${TOKEN_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`;
}

/** What a device may reach unpaired: the pairing page, its script, the trade itself, and the 404 MCP clients probe for. */
export function openUnpaired(method: string, path: string): boolean {
  return (method === 'GET' && (path === '/pair' || path === '/pair.js')) || (method === 'POST' && path === '/api/pair') || path.startsWith('/.well-known/');
}

/**
 * After requestGuard: a request from this machine passes as before; any other needs a paired device's token (#403).
 * A page load without one goes to /pair; anything else (the API, /ws, /mcp) gets a 401 saying how to pair.
 */
export function pairingGuard(pairing: Pairing, log?: (level: 'warn', msg: string) => void): MiddlewareHandler {
  return async (c, next) => {
    if (fromThisMachine(c) || openUnpaired(c.req.method, c.req.path)) return next();
    if (pairing.check(requestToken(c))) return next();
    const page = c.req.method === 'GET' && !/^\/(api|mcp|ws|attachments)(\/|$)/.test(c.req.path) && (c.req.header('accept') ?? '').includes('text/html');
    if (page) return c.redirect('/pair', 302);
    log?.('warn', `refused ${c.req.method} ${c.req.path}: no paired device's token`);
    c.header('www-authenticate', 'Bearer realm="planestro"');
    return c.json({ error: 'this device is not paired: run `planestro pair` on the machine running planestro and enter the code at /pair (an MCP client sends the token it gives as Authorization: Bearer)' }, 401);
  };
}

/** The pairing page: plain HTML, its script served beside it (the CSP allows only scripts from planestro itself). */
export const PAIR_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pair this device · planestro</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif}
body{max-width:28rem;margin:3rem auto;padding:0 1rem;line-height:1.5}
input,button{font:inherit;padding:.5rem .6rem;width:100%;box-sizing:border-box;margin:.25rem 0 .75rem}
button{cursor:pointer}
code{word-break:break-all}
.err{color:#c0392b}
</style></head>
<body>
<h1>Pair this device</h1>
<p>On the machine running planestro, run <code>planestro pair</code> (or <b>Settings → Access → Paired devices → Pair a device</b> there) and enter the code it shows.</p>
<form id="pair">
<label for="code">Code</label><input id="code" name="code" autocomplete="one-time-code" autocapitalize="characters" placeholder="ABCD-EFGH" required>
<label for="name">This device's name</label><input id="name" name="name" placeholder="phone" maxlength="80">
<button type="submit">Pair</button>
</form>
<p id="out" role="status"></p>
<script src="/pair.js"></script>
</body></html>
`;

export const PAIR_SCRIPT = `document.getElementById('pair').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = document.getElementById('out');
  out.className = ''; out.textContent = 'Pairing…';
  const body = { code: document.getElementById('code').value, name: document.getElementById('name').value };
  try {
    const r = await fetch('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) { out.className = 'err'; out.textContent = j.error || 'Pairing failed'; return; }
    out.innerHTML = '';
    const p = document.createElement('p'); p.textContent = 'Paired as ' + j.device.name + '. This browser is signed in. For an MCP client on this device, send this token as Authorization: Bearer (it is shown only once):';
    const code = document.createElement('code'); code.textContent = j.token;
    const a = document.createElement('a'); a.href = '/'; a.textContent = 'Open planestro';
    out.append(p, code, document.createElement('br'), a);
  } catch (err) { out.className = 'err'; out.textContent = String(err); }
});
`;

/** The pairing routes, on the app itself (before `/api`'s own): the page, the trade, minting (this machine only), devices. */
export function pairingRoutes(app: Hono, pairing: Pairing): void {
  const asset = (body: string, type: string) => new Response(body, { headers: { 'content-type': type, 'cache-control': 'no-store', 'content-security-policy': `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'` } });
  app.get('/pair', () => asset(PAIR_PAGE, 'text/html; charset=utf-8'));
  app.get('/pair.js', () => asset(PAIR_SCRIPT, 'text/javascript; charset=utf-8'));
  app.post('/api/pair', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { code?: unknown; name?: unknown };
    if (typeof body.code !== 'string') return c.json({ error: 'send {code, name}' }, 400);
    const r = pairing.redeem(body.code, typeof body.name === 'string' ? body.name : undefined);
    if ('error' in r) return c.json({ error: r.error }, 401);
    c.header('set-cookie', tokenCookie(r.token));
    return c.json(r);
  });
  app.post('/api/pairing/code', (c) => fromThisMachine(c) ? c.json(pairing.mint()) : c.json({ error: 'a pairing code is minted only on the machine running planestro (planestro pair, or Settings there)' }, 403));
  app.get('/api/pairing/devices', (c) => c.json({ devices: pairing.devices() }));
  app.delete('/api/pairing/devices/:id', (c) => pairing.revoke(c.req.param('id')) ? c.json({ devices: pairing.devices() }) : c.json({ error: `no paired device ${c.req.param('id')}` }, 404));
}
