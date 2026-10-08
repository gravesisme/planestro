import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createNodeWebSocket } from '@hono/node-ws';
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
import { allowedHosts, bindHost, linkRefusal, requestGuard } from './guard.ts';
import { PortInUseError } from './exitCodes.ts';

export interface ServeOptions { dataDir: string; port?: number; host?: string; mock?: boolean; engineFactory?: (store: DataStore, emit: (e: ServerEvent) => void) => Engine; log?: (level: string, msg: string) => void }

export async function startServer(o: ServeOptions) {
  const log = o.log ?? ((level, msg) => console.log(`[${level}] ${msg}`));
  const sockets = new Set<{ send(data: string): void }>();
  const consoles = new ConsoleBuffer();
  // The engine sees every store event too, to tell when an item comes to need you (#224); it is made after the store.
  let observer: Engine | undefined;
  const emit = (e: ServerEvent) => { consoles.handle(e); const data = JSON.stringify(e); for (const s of sockets) { try { s.send(data); } catch { /* closed */ } } observer?.observe?.(e); };
  const store = await DataStore.open(o.dataDir, { emit, log: (l, m) => log(l, m) });
  const port = o.port ?? 4300;
  const host = bindHost(o.host, store.local);
  const defaultFactory = (s: DataStore, em: (e: ServerEvent) => void): Engine => {
    if (o.mock) return new MockEngine(s, em);
    const mode = s.local.engine.mode ?? s.config.engine.mode;
    return new LiveEngine(s, makePorts(mode, (m) => { log('info', m); em({ type: 'engine.log', level: 'info', message: m }); }, s), em, { listenUrl: listenUrl(host, port) });
  };
  const engine = (o.engineFactory ?? defaultFactory)(store, emit);
  observer = engine;
  const app = new Hono();
  // Before every route, the WebSocket upgrade included: see guard.ts.
  app.use('*', requestGuard(allowedHosts(host, store.local.allowed_hosts), (l, m) => log(l, m), { lanOnly: store.local.lan_access }));
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
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
  if (existsSync(join(webDist, 'index.html'))) {
    const root = relative(process.cwd(), webDist) || '.';
    app.use('/*', serveStatic({ root }));
    app.get('*', (c) => c.html(readFileSync(join(webDist, 'index.html'), 'utf8')));
  } else {
    app.get('/', (c) => c.text(`planestro ${TOOL_VERSION} API is up; the web UI is not built (run \`npm run build\`, or \`npm run dev:web\` for Vite on :5173).`));
  }

  const server = serve({ fetch: app.fetch, port, hostname: host }, () => log('info', `planestro ${TOOL_VERSION} on http://${host}:${port} — data ${store.dataDir} (${store.schema}, ${store.items.size} items) — engine ${engine.mode}${engine.paused ? ' PAUSED' : ''}`));
  injectWebSocket(server);
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

  const checkpoint = setInterval(() => { store.git.checkpoint(); void store.git.push(); }, store.config.git.checkpoint_interval_min * 60_000);
  checkpoint.unref();
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return; shuttingDown = true;
    log('info', 'shutting down');
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
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
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
    `lan_access: ${local.lan_access ? 'on' : 'off'}, listening on ${host}:${port} unless --host says otherwise${local.lan_access ? ' (anyone on this network can use planestro)' : ''}`,
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
