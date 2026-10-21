import { Hono } from 'hono';
import { createAdaptorServer, upgradeWebSocket } from '@hono/node-server';
import { compress } from 'hono/compress';
import { serveStatic } from '@hono/node-server/serve-static';
import { WebSocketServer } from 'ws';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import type { Config, LocalConfig, ServerEvent } from '@planestro/shared';
import { DataStore } from './store/DataStore.ts';
import { apiRoutes, attachmentRoutes } from './routes/api.ts';
import { operatorMcpRoutes } from './routes/mcp.ts';
import { ConsoleBuffer } from './store/ConsoleBuffer.ts';
import type { Engine } from './engine/Engine.ts';
import { MockEngine } from './engine/MockEngine.ts';
import { LiveEngine } from './engine/LiveEngine.ts';
import { makePorts } from './engine/makePorts.ts';
import { VALIDATED_CLAUDE_VERSION, VALIDATED_CODEX_VERSION } from './compat.ts';
import { TOOL_VERSION } from './config.ts';
import { allowedHosts, bindHost, isLoopbackBind, linkRefusal, requestGuard } from './guard.ts';
import { PortInUseError } from './exitCodes.ts';
import { Pairing, pairingGuard, pairingRoutes } from './pairing.ts';
import type { HandedPort } from './portHandoff.ts';

export interface ServeOptions { dataDir: string; port?: number; host?: string; mock?: boolean; engineFactory?: (store: DataStore, emit: (e: ServerEvent) => void) => Engine; log?: (level: string, msg: string) => void;
  /** The socket `serve --watch` holds across restarts (#354): its host and port win over the flags and lan_access. */
  listen?: HandedPort }

/**
 * The app shell's Content-Security-Policy: everything from planestro itself. Model-written text is shown as markdown,
 * and nothing in it may fetch from elsewhere (an image's URL can carry what the page shows). React sets inline styles.
 * The WebSocket is named by host as well as 'self', which older Safari does not extend to ws:.
 */
export function appCsp(host?: string): string {
  const ws = host && /^[\w.:\[\]-]+$/.test(host) ? ` ws://${host} wss://${host}` : '';
  return [`default-src 'self'`, `script-src 'self'`, `style-src 'self' 'unsafe-inline'`, `img-src 'self' data: blob:`, `media-src 'self' data: blob:`,
    `connect-src 'self'${ws}`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, `form-action 'self'`].join('; ');
}

/**
 * The built web UI. The page that names the bundles is always revalidated (#280): a reload answered with a stale page
 * loads the bundles it names, and an installed iPhone web app came back from the background to a black screen. The
 * bundles are content-hashed, so they may be cached.
 */
export function serveWeb(app: Hono, webDist: string): void {
  const root = relative(process.cwd(), webDist) || '.';
  app.use('/*', async (c, next) => {
    await next();
    if (!c.res.headers.get('content-type')?.startsWith('text/html')) return;
    c.res.headers.set('cache-control', 'no-cache');
    c.res.headers.set('content-security-policy', appCsp(c.req.header('host')));
  });
  app.use('/*', serveStatic({ root }));
  app.get('*', (c) => c.html(readFileSync(join(webDist, 'index.html'), 'utf8')));
}

let strayErrorsLog: ((msg: string) => void) | undefined;
/** Installed once per process; the latest server's log hears them. */
function keepRunningOnStrayErrors(log: (msg: string) => void): void {
  if (!strayErrorsLog) {
    process.on('unhandledRejection', (e) => strayErrorsLog?.(`unhandled rejection: ${(e as Error)?.stack ?? String(e)}`));
    process.on('uncaughtException', (e) => strayErrorsLog?.(`uncaught exception: ${e.stack ?? e.message}`));
  }
  strayErrorsLog = log;
}

export async function startServer(o: ServeOptions) {
  const log = o.log ?? ((level, msg) => console.log(`[${level}] ${msg}`));
  const sockets = new Set<{ send(data: string): void }>();
  const consoles = new ConsoleBuffer();
  // The engine sees every store event too, to tell when an item comes to need you (#224); it is made after the store.
  let observer: Engine | undefined;
  const emit = (e: ServerEvent) => { consoles.handle(e); const data = JSON.stringify(e); for (const s of sockets) { try { s.send(data); } catch { /* closed */ } } observer?.observe?.(e); };
  const store = await DataStore.open(o.dataDir, { emit, log: (l, m) => log(l, m) });
  const port = o.listen?.port ?? o.port ?? 4300;
  const host = o.listen?.host ?? bindHost(o.host, store.local);
  const defaultFactory = (s: DataStore, em: (e: ServerEvent) => void): Engine => {
    if (o.mock) return new MockEngine(s, em);
    const mode = s.local.engine.mode ?? s.config.engine.mode;
    return new LiveEngine(s, makePorts(mode, (m) => { log('info', m); em({ type: 'engine.log', level: 'info', message: m }); }, s), em, { listenUrl: listenUrl(host, port), log });
  };
  const engine = (o.engineFactory ?? defaultFactory)(store, emit);
  observer = engine;
  const app = new Hono();
  // Before every route, the WebSocket upgrade included: see guard.ts.
  app.use('*', requestGuard(allowedHosts(host, store.local.allowed_hosts), (l, m) => log(l, m), { lanOnly: store.local.lan_access || !isLoopbackBind(host), declared: store.local.allowed_hosts }));
  // Then a paired device's token from anywhere but this machine (#403): this machine needs none, as before.
  const pairing = new Pairing(store);
  app.use('*', pairingGuard(pairing, (l, m) => log(l, m)));
  pairingRoutes(app, pairing, { host, port });
  // The API's JSON only (the state payload runs to megabytes, too slow for a phone on slow Wi-Fi); never /ws or /mcp's streams.
  app.use('/api/*', compress({ contentTypeFilter: /^application\/json/ }));
  app.route('/api', apiRoutes(store, engine, consoles));
  app.route('/attachments', attachmentRoutes(store));
  // The operator MCP endpoint (#175): read-only, for an MCP client registered at user scope; never a worker's.
  app.route('/mcp', operatorMcpRoutes(store, engine));
  // No OAuth here: an MCP client's discovery probes must get a 404, not the web UI's index.html as a 200.
  app.all('/.well-known/*', (c) => c.json({ error: 'not found' }, 404));
  app.get('/ws', upgradeWebSocket(() => ({
    onOpen(_evt, ws) { sockets.add(ws as any); (ws as any).send(JSON.stringify({ type: 'engine.paused', paused: engine.paused })); },
    onClose(_evt, ws) { sockets.delete(ws as any); },
    // The client's heartbeat, sent on input at most once a minute: someone is at planestro now (#224).
    onMessage(evt) { try { if (JSON.parse(String(evt.data)).type === 'client.active') engine.clientActive?.(); } catch { /* not ours */ } },
  })));
  app.get('/healthz', (c) => c.json({ ok: true, version: TOOL_VERSION }));

  const webDist = new URL('../../web/dist/', import.meta.url).pathname;
  if (existsSync(join(webDist, 'index.html'))) serveWeb(app, webDist);
  else {
    app.get('/', (c) => c.text(`planestro ${TOOL_VERSION} API is up; the web UI is not built (run \`npm run build\`, or \`npm run dev:web\` for Vite on :5173).`));
  }

  // WebSockets are the adapter's own since v2 (it was @hono/node-ws): upgrades still go through app.fetch, guards first.
  const server = createAdaptorServer({ fetch: app.fetch, websocket: { server: new WebSocketServer({ noServer: true }) } });
  server.listen(o.listen ? o.listen.handle as never : { port, host }, () => log('info', `planestro ${TOOL_VERSION} on http://${host}:${port} — data ${store.dataDir} (${store.schema}, ${store.items.size} items) — engine ${engine.mode}${engine.paused ? ' PAUSED' : ''}`));
  // Own the port before the engine starts anything: a taken port used to surface as an uncaught
  // 'error' after the engine was already up. Release the data-dir lock and say which it was, so
  // `serve --watch` can stop instead of waiting for a source change (#85, LM 2026-09-28).
  await new Promise<void>((listening, failed) => {
    server.once('listening', () => listening());
    server.once('error', (e: NodeJS.ErrnoException) => { store.close(); failed(e.code === 'EADDRINUSE' ? new PortInUseError(host, port) : e); });
  });
  const selected = [store.config.defaults.planner, store.config.defaults.implementer, store.config.orchestrator.model, ...store.listItems().filter((i) => !['FINISHED', 'ICEBOX'].includes(i.file.frontmatter.status)).flatMap((i) => [i.file.frontmatter.planner, i.file.frontmatter.implementer])];
  if (store.config.models.some((m) => (m.runner ?? 'claude') === 'claude' && selected.some((ref) => ref === m.id || ref === m.claude_model))) warnOnClaudeDrift(log);
  warnOnCodexDrift(store, log);
  await engine.start();

  const checkpoint = setInterval(() => {
    try { store.git.checkpoint(); } catch (e) { log('error', `checkpoint: ${(e as Error).message}`); }
    void store.git.push().catch((e: unknown) => log('error', `push: ${(e as Error).message}`));
  }, store.config.git.checkpoint_interval_min * 60_000);
  checkpoint.unref();
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return; shuttingDown = true;
    log('info', 'shutting down');
    // On a held port, stop accepting first: what arrives from here on waits for the next server, not for this one to exit under it.
    if (o.listen) { server.close(); (server as { closeIdleConnections?: () => void }).closeIdleConnections?.(); }
    clearInterval(checkpoint);
    // Commit first and synchronously: a supervisor (tsx relays SIGINT to its child) may kill us
    // before anything async completes. Everything after this line is best-effort.
    await store.flushCommits();
    store.git.checkpoint();
    await engine.stop();
    await store.git.push();
    store.close();
    server.close();
    process.exit(0);
  };
  // A second Ctrl-C ends it now: a shutdown waiting on a stuck step must not need a kill -9.
  let signals = 0;
  const onSignal = () => { if (++signals > 1) { log('warn', 'second signal: exiting without waiting'); process.exit(130); } void shutdown(); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  // planestro runs unattended (invariant 2): an error nothing caught is logged and the server goes on. Node's default
  // ends the process, which loses every turn in flight; the disk guard pauses automation when the cause is a full disk.
  keepRunningOnStrayErrors((msg) => log('error', msg));
  return { store, engine, server, shutdown };
}

/**
 * The address the server answers on, for links in notifications. A wildcard bind is reached by this machine's
 * mDNS name, `<hostname>.local`, which iOS and current Android resolve on the same Wi-Fi (#255).
 */
export function listenUrl(host: string, port: number): string {
  const name = host === '0.0.0.0' || host === '::' ? `${hostname().toLowerCase().replace(/\.local$/, '')}.local` : host;
  return `http://${name.includes(':') ? `[${name}]` : name}:${port}`;
}

/** `planestro check`'s lines on access (#255): the setting, where it listens, the link address, and a link the guard would refuse. */
export function accessReport(local: Pick<LocalConfig, 'lan_access' | 'allowed_hosts'>, notifications: Pick<Config['notifications'], 'base_url'>, port: number): string[] {
  const host = bindHost(undefined, local);
  const link = notifications.base_url ?? listenUrl(host, port);
  const refusal = linkRefusal(link, allowedHosts(host, local.allowed_hosts));
  return [
    `lan_access: ${local.lan_access ? 'on' : 'off'}, listening on ${host}:${port} unless --host says otherwise${local.lan_access ? ' (a paired device on this network can use planestro: planestro pair)' : ''}`,
    `link address: ${link}${notifications.base_url ? ' (notifications.base_url)' : ''}`,
    ...(refusal ? [`WARN ${refusal}`] : []),
  ];
}

/** Only when a model actually runs on Codex: a project that never uses it should not hear about it. */
function warnOnCodexDrift(store: DataStore, log: (level: string, msg: string) => void): void {
  const selected = [store.config.defaults.planner, store.config.defaults.implementer, store.config.orchestrator.model, ...store.listItems().filter((i) => !['FINISHED', 'ICEBOX'].includes(i.file.frontmatter.status)).flatMap((i) => [i.file.frontmatter.planner, i.file.frontmatter.implementer])];
  if (!store.config.models.some((m) => m.runner === 'codex' && selected.some((ref) => ref === m.id || ref === m.codex_model))) return;
  try {
    const v = execFileSync(store.local.codex_bin ?? 'codex', ['--version'], { encoding: 'utf8' }).trim().split(' ').pop();
    if (v !== VALIDATED_CODEX_VERSION) log('warn', `⚠ Codex CLI changed ${VALIDATED_CODEX_VERSION} → ${v} since the Codex runner was last validated (docs/notes/codex-spike.md)`);
  } catch { log('warn', 'a model uses the codex runner but the codex CLI is not on PATH; its turns will fail to start'); }
}

function warnOnClaudeDrift(log: (level: string, msg: string) => void): void {
  try {
    const v = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim().split(' ')[0];
    if (v !== VALIDATED_CLAUDE_VERSION) log('warn', `⚠ Claude Code changed ${VALIDATED_CLAUDE_VERSION} → ${v} since orchestration compatibility was last validated (docs/notes/sdk-notes.md)`);
  } catch { log('warn', 'claude CLI not found on PATH; sessions cannot run'); }
}
