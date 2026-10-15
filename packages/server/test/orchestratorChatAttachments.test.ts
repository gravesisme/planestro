import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { DataStore } from '../src/store/DataStore.ts';
import { LiveEngine } from '../src/engine/LiveEngine.ts';
import { apiRoutes, attachmentRoutes } from '../src/routes/api.ts';
import { InputGate } from '../src/engine/sessions/LiveClaudePort.ts';
import { FakeWorld, DryRunGitPort, DryRunGhPort, DryRunProcPort } from '../src/engine/dryrun-ports.ts';
import type { Ports, TurnResult, CustomTurnOptions } from '../src/engine/ports.ts';
import { makeFixture, git, sleep } from './helpers.ts';

let store: DataStore | undefined; let engine: LiveEngine | undefined;
afterEach(async () => { await engine?.stop(); store?.close(); store = undefined; engine = undefined; });

const ok: TurnResult = { sessionId: 'orch', subtype: 'success', isError: false, costUsd: 0, numTurns: 1, text: '' };
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4f00000000049454e44ae426082', 'hex');

async function setup() {
  const { dataDir } = makeFixture();
  store = await DataStore.open(dataDir);
  const wakes: CustomTurnOptions[] = [];
  const claude: Ports['agents']['claude'] = {
    async runTurn(): Promise<TurnResult> { return ok; },
    async runCustomTurn(o: CustomTurnOptions): Promise<TurnResult> {
      wakes.push(o);
      await o.mcpTools.find((t) => t.name === 'done_with_wake')!.handler({ summary: 'looked' });
      return ok;
    },
  };
  const world = new FakeWorld(() => {}, { 'origin/trunk': 'f'.repeat(40) });
  const ports: Ports = { mode: 'dry-run', git: new DryRunGitPort(world), gh: new DryRunGhPort(world), proc: new DryRunProcPort(world), agents: { claude } };
  engine = new LiveEngine(store, ports, () => {}, { sleep: async () => {}, tickMs: 50 });
  const app = new Hono();
  app.route('/api', apiRoutes(store, engine));
  app.route('/attachments', attachmentRoutes(store));
  return { store, engine, wakes, dataDir, app };
}
async function waitFor(pred: () => boolean, ms = 5000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(20); } }
const send = (app: Hono, text: string, files: [string, Buffer, string][] = [], item?: string) => {
  const fd = new FormData();
  fd.append('text', text);
  if (item) fd.append('item', item);
  for (const [name, data, type] of files) fd.append('file', new File([new Uint8Array(data)], name, { type }));
  return app.request('/api/orchestrator/message', { method: 'POST', body: fd });
};
const lastMessage = (s: DataStore) => s.journal.read({ type: 'orchestrator.user_message' }).at(-1)!;

describe('the orchestrator chat takes images and files (#288)', () => {
  it('stores them in the data dir, commits them, records them on the message, and the wake carries them', async () => {
    const { store: s, wakes, dataDir, app } = await setup();
    const long = `Here is what I see on the board.\n${'The column header overlaps the cards when the window is narrow. '.repeat(60)}\nThe end of my message.`;
    const r = await send(app, long, [['board shot.png', PNG, 'image/png'], ['notes.md', Buffer.from('# Notes\nsteps to reproduce'), 'text/markdown']]);
    expect(r.status).toBe(200);

    const entry = lastMessage(s);
    expect(entry.data?.text).toBe(long);
    const atts = entry.data?.attachments as { path: string; name: string; kind: string; bytes: number }[];
    expect(atts.map((a) => [a.name, a.kind, a.bytes])).toEqual([['board shot.png', 'image', PNG.length], ['notes.md', 'file', 26]]);
    for (const a of atts) {
      expect(a.path).toMatch(/^attachments\/chat\/[A-Za-z0-9._-]+$/);
      expect(existsSync(join(dataDir, a.path))).toBe(true);
    }
    expect(readFileSync(join(dataDir, atts[0].path))).toEqual(PNG);
    expect(git(dataDir, 'log', '--format=%s')).toMatch(/^chat: attach board-shot\.png, notes\.md$/m);
    expect(git(dataDir, 'status', '--porcelain', '--', 'attachments')).toBe('');

    await waitFor(() => wakes.length === 1);
    const w = wakes[0];
    const abs = atts.map((a) => s.chatAttachmentAbsPath(a.path));
    expect(w.images).toEqual([abs[0]]);                     // the image goes to the model itself
    expect(w.prompt).toContain(abs[0]);                     // and every attachment is named by a path it can Read
    expect(w.prompt).toContain(abs[1]);
    expect(w.prompt).toContain('The end of my message.');   // a long message reaches the wake whole
    expect(w.prompt).toMatch(/notes\.md \(file/);

    // The thread can show them.
    const img = await app.request('/' + atts[0].path);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    const chat = await (await app.request('/api/orchestrator/chat')).json();
    expect(chat.entries.find((j: { type: string }) => j.type === 'orchestrator.user_message').data.attachments).toHaveLength(2);
  });

  it('a message may be only an attachment; JSON messages still work', async () => {
    const { store: s, wakes, app } = await setup();
    expect((await send(app, '', [['shot.png', PNG, 'image/png']])).status).toBe(200);
    expect(lastMessage(s).data?.text).toBe('');
    const r = await app.request('/api/orchestrator/message', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'plain words' }) });
    expect(r.status).toBe(200);
    expect(lastMessage(s).data).toEqual({ text: 'plain words' });
    expect((await send(app, '   ')).status).toBe(400);   // nothing to send
    await waitFor(() => wakes.length >= 1);
  });

  it('refuses unsupported types, too many files and files over the size limit, and writes nothing', async () => {
    const { store: s, dataDir, app } = await setup();
    const before = s.journal.read({ type: 'orchestrator.user_message' }).length;
    const refused = [
      await send(app, 'run this', [['tool.exe', Buffer.from('MZ'), 'application/octet-stream']]),
      await send(app, 'big', [['huge.png', Buffer.alloc(s.config.attachments.managed_max_bytes + 1), 'image/png']]),
      await send(app, 'many', Array.from({ length: 9 }, (_, i) => [`s${i}.png`, PNG, 'image/png'] as [string, Buffer, string])),
      await send(app, 'mixed', [['ok.png', PNG, 'image/png'], ['page.html', Buffer.from('<script>'), 'text/html']]),
    ];
    expect(refused.map((r) => r.status)).toEqual([400, 400, 413, 400]);   // too many files is refused like an oversized body (#336)
    expect(s.journal.read({ type: 'orchestrator.user_message' }).length).toBe(before);
    expect(existsSync(join(dataDir, 'attachments', 'chat')) ? readdirSync(join(dataDir, 'attachments', 'chat')) : []).toEqual([]);
  });

  it('a message sent while automation is paused is kept, and its wake carries the images on resume', async () => {
    const { store: s, engine: e, wakes, app } = await setup();
    e.pause();
    expect((await send(app, 'look', [['shot.png', PNG, 'image/png']])).status).toBe(200);
    await sleep(200);
    expect(wakes).toHaveLength(0);
    e.resume();
    await waitFor(() => wakes.length === 1);
    expect(wakes[0].images).toEqual([s.chatAttachmentAbsPath((lastMessage(s).data?.attachments as { path: string }[])[0].path)]);
  });

  it('a fresh conversation hears what the user attached lately', async () => {
    const { wakes, app } = await setup();
    await send(app, 'see this', [['shot.png', PNG, 'image/png']]);
    await waitFor(() => wakes.length === 1);
    expect(wakes[0].prompt).toMatch(/user: see this \(attached: shot\.png at \/.*shot\.png\)/);
  });

  it('the chat route serves only regular files inside attachments/chat', async () => {
    const { app, dataDir } = await setup();
    writeFileSync(join(dataDir, 'planestro-secret.txt'), 'private');
    for (const p of ['/attachments/chat/..%2Fplanestro-secret.txt', '/attachments/chat/missing.png', '/attachments/chat/']) expect((await app.request(p)).status, p).toBe(404);
  });
});

describe('runners get the images (#288)', () => {
  it('Claude: the first message carries each image as content beside the text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'planestro-chat-img-'));
    try {
      const png = join(dir, 'shot.png'); writeFileSync(png, PNG);
      const jpg = join(dir, 'photo.jpg'); writeFileSync(jpg, Buffer.from('ffd8ffe0', 'hex'));
      const g = new InputGate();
      const first = (await g.open('look at these', [png, jpg]).next()).value;
      g.close();
      expect(first.message.content).toEqual([
        { type: 'text', text: 'look at these' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/4A==' } },
      ]);
      const plain = new InputGate();
      expect((await plain.open('hi').next()).value.message.content).toBe('hi');
      plain.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
