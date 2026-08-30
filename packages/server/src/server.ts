import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createNodeWebSocket } from '@hono/node-ws';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ServerEvent } from '@planestro/shared';
import { DataStore } from './store/DataStore.ts';
import { apiRoutes, attachmentRoutes } from './routes/api.ts';
import type { Engine } from './engine/Engine.ts';
import { MockEngine } from './engine/MockEngine.ts';
import { LiveEngine } from './engine/LiveEngine.ts';
import { makePorts } from './engine/makePorts.ts';
import { VALIDATED_CLAUDE_VERSION } from './compat.ts';
import { TOOL_VERSION } from './config.ts';

export interface ServeOptions { dataDir: string; port?: number; host?: string; mock?: boolean; engineFactory?: (store: DataStore, emit: (e: ServerEvent) => void) => Engine; log?: (level: string, msg: string) => void }

export async function startServer(o: ServeOptions) {
  const log = o.log ?? ((level, msg) => console.log(`[${level}] ${msg}`));
  const sockets = new Set<{ send(data: string): void }>();
  const emit = (e: ServerEvent) => { const data = JSON.stringify(e); for (const s of sockets) { try { s.send(data); } catch { /* closed */ } } };
  const store = await DataStore.open(o.dataDir, { emit, log: (l, m) => log(l, m) });
  const defaultFactory = (s: DataStore, em: (e: ServerEvent) => void): Engine => {
    if (o.mock) return new MockEngine(s, em);
    const mode = s.local.engine.mode ?? s.config.engine.mode;
    return new LiveEngine(s, makePorts(mode, (m) => { log('info', m); em({ type: 'engine.log', level: 'info', message: m }); }, s), em);
  };
  const engine = (o.engineFactory ?? defaultFactory)(store, emit);

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  app.route('/api', apiRoutes(store, engine));
  app.route('/attachments', attachmentRoutes(store));
  app.get('/ws', upgradeWebSocket(() => ({
    onOpen(_evt, ws) { sockets.add(ws as any); (ws as any).send(JSON.stringify({ type: 'engine.paused', paused: engine.paused })); },
    onClose(_evt, ws) { sockets.delete(ws as any); },
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

  const port = o.port ?? 4300;
  const host = o.host ?? '127.0.0.1';
  const server = serve({ fetch: app.fetch, port, hostname: host }, () => log('info', `planestro ${TOOL_VERSION} on http://${host}:${port} — data ${store.dataDir} (${store.schema}, ${store.items.size} items) — engine ${engine.mode}${engine.paused ? ' PAUSED' : ''}`));
  injectWebSocket(server);
  warnOnClaudeDrift(log);
  await engine.start();

  const checkpoint = setInterval(() => { store.git.checkpoint(); void store.git.push(); }, store.config.git.checkpoint_interval_min * 60_000);
  checkpoint.unref();
  const shutdown = async () => {
    log('info', 'shutting down');
    clearInterval(checkpoint);
    await engine.stop();
    await store.flushCommits();
    store.git.checkpoint();
    await store.git.push();
    store.close();
    server.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  return { store, engine, server, shutdown };
}

function warnOnClaudeDrift(log: (level: string, msg: string) => void): void {
  try {
    const v = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim().split(' ')[0];
    if (v !== VALIDATED_CLAUDE_VERSION) log('warn', `⚠ Claude Code changed ${VALIDATED_CLAUDE_VERSION} → ${v} since orchestration compatibility was last validated (docs/sdk-notes.md)`);
  } catch { log('warn', 'claude CLI not found on PATH; sessions cannot run'); }
}
