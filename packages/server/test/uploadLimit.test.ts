import { describe, it, expect, afterEach } from 'vitest';
import { Hono } from 'hono';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { apiRoutes } from '../src/routes/api.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort, DryRunClaudePort } from '../src/engine/dryrun-ports.ts';
import type { Ports } from '../src/engine/ports.ts';
import { CHAT_MAX_FILES } from '@planestro/shared';
import { makeFixture } from './helpers.ts';

/** Uploads are bounded before they are read (#336): an oversized or over-count one is refused with 413, and its body is never buffered. */
let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4f00000000049454e44ae426082', 'hex');
const CHUNK = 64 * 1024;

async function setup() {
  const { dataDir } = makeFixture();
  store = await DataStore.open(dataDir);
  store.updateConfig((doc) => { doc.setIn(['attachments', 'managed_max_bytes'], 100_000); }, 'config: small attachments');
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude: new DryRunClaudePort(world) } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  const app = new Hono();
  app.route('/api', apiRoutes(store, engine));
  return { store, app, item: store.createItem({ title: 'Uploads' }) };
}

/** A multipart body that never ends, counting what was read of it: a limit that buffers first would read it all. */
function endless() {
  const read = { bytes: 0 };
  const boundary = 'xyz';
  const head = new TextEncoder().encode(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="big.png"\r\ncontent-type: image/png\r\n\r\n`);
  let first = true;
  const body = new ReadableStream<Uint8Array>({ pull(c) { const chunk = first ? head : new Uint8Array(CHUNK); first = false; read.bytes += chunk.length; c.enqueue(chunk); } });
  return { read, init: { method: 'POST', body, duplex: 'half', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } } as RequestInit };
}
const form = (files: number, size = PNG.length) => {
  const fd = new FormData(); fd.append('text', 'look');
  for (let i = 0; i < files; i++) fd.append('file', new File([new Uint8Array(size === PNG.length ? PNG : Buffer.alloc(size))], `s${i}.png`, { type: 'image/png' }));
  return { method: 'POST', body: fd };
};

describe('uploads are bounded before they are buffered (#336)', () => {
  it('an oversized body is refused with 413 from its Content-Length, before any of it is read', async () => {
    const { app, item } = await setup();
    for (const path of [`/api/items/${item.id}/attachments`, '/api/orchestrator/message']) {
      const { read, init } = endless();
      const r = await app.request(path, { ...init, headers: { ...(init.headers as Record<string, string>), 'content-length': String(50_000_000) } });
      expect(r.status, path).toBe(413);
      expect((await r.json()).error, path).toMatch(/^the upload is over the \d+(\.\d)? MB limit: at most \d+ files? of 0\.1 MB each \(attachments\.managed_max_bytes\)$/);
      expect(read.bytes, path).toBeLessThan(CHUNK);   // the stream's own first pull: nothing past the part's headers
    }
  });

  it('a streamed body with no length is cut off as soon as it passes the limit', async () => {
    const { app, item } = await setup();
    const one = endless();
    const r = await app.request(`/api/items/${item.id}/attachments`, one.init);
    expect(r.status).toBe(413);
    expect((await r.json()).error).toMatch(/at most 1 file of 0\.1 MB each/);
    expect(one.read.bytes).toBeLessThan(100_000 + 256 * 1024 + 3 * CHUNK);
    const chat = endless();
    expect((await app.request('/api/orchestrator/message', chat.init)).status).toBe(413);
    expect(chat.read.bytes).toBeLessThan(CHAT_MAX_FILES * 100_000 + 256 * 1024 + 3 * CHUNK);
  });

  it('more files than a route takes are refused with 413, and nothing is stored', async () => {
    const { store: s, app, item } = await setup();
    const r = await app.request(`/api/items/${item.id}/attachments`, form(2));
    expect(r.status).toBe(413);
    expect((await r.json()).error).toBe('one file per upload');
    expect(s.requireItem(item.id).file.frontmatter.attachments).toEqual([]);
    const chat = await app.request('/api/orchestrator/message', form(CHAT_MAX_FILES + 1));
    expect(chat.status).toBe(413);
    expect((await chat.json()).error).toBe(`at most ${CHAT_MAX_FILES} attachments in one message`);
  });

  it('uploads within the limits still work', async () => {
    const { store: s, app, item } = await setup();
    const r = await app.request(`/api/items/${item.id}/attachments`, form(1, 90_000));
    expect(r.status).toBe(201);
    expect(s.requireItem(item.id).file.frontmatter.attachments).toHaveLength(1);
    expect((await app.request('/api/orchestrator/message', form(CHAT_MAX_FILES))).status).toBe(200);
  });
});
