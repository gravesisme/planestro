import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { DataStore } from '../src/store/DataStore.ts';
import { attachmentRoutes } from '../src/routes/api.ts';
import { requestGuard, allowedHosts } from '../src/guard.ts';
import { makeFixture } from './helpers.ts';

let store: DataStore | undefined;
afterEach(() => { store?.close(); store = undefined; });
async function setup() {
  const f = makeFixture();
  store = await DataStore.open(f.dataDir);
  const item = store.createItem({ title: 'Attachment boundaries' });
  const app = new Hono();
  app.use('*', requestGuard(allowedHosts('127.0.0.1')));
  app.route('/attachments', attachmentRoutes(store));
  const get = (path: string) => app.request(path, { headers: { host: '127.0.0.1:4300' } });
  return { ...f, store, item, get };
}

describe('managed attachments are untrusted files, not application documents', () => {
  it('downloads active formats with a sandbox and nosniff; keeps raster images and plain text usable', async () => {
    const { store, item, get } = await setup();
    for (const name of ['payload.svg', 'payload.html', 'payload.pdf', 'payload.bin']) {
      const a = store.addManagedAttachment(item.id, name, Buffer.from('<svg><script>fetch("/api/state")</script></svg>'));
      const r = await get('/' + a.path);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('application/octet-stream');
      expect(r.headers.get('content-disposition')).toMatch(/^attachment;/);
      expect(r.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'; base-uri 'none'; form-action 'none'");
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    }
    for (const [name, type] of [['shot.png', 'image/png'], ['note.md', 'text/plain']]) {
      const a = store.addManagedAttachment(item.id, name, Buffer.from('sample'));
      const r = await get('/' + a.path);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe(type);
      expect(r.headers.get('content-disposition')).toMatch(/^inline;/);
      expect(await r.text()).toBe('sample');
    }
  });

  it('rejects encoded traversal, sibling-prefix matches, unknown items and non-files', async () => {
    const { store, item, dataDir, get } = await setup();
    store.addManagedAttachment(item.id, 'normal.txt', Buffer.from('ok'));
    mkdirSync(join(dataDir, 'attachments-extra'));
    writeFileSync(join(dataDir, 'attachments-extra', 'probe.txt'), 'private marker');
    mkdirSync(join(store.attachmentsDir, 'TP-999'));
    writeFileSync(join(store.attachmentsDir, 'TP-999', 'probe.txt'), 'unregistered item');
    mkdirSync(join(store.attachmentsDir, item.id, 'folder'));
    for (const path of ['/attachments/..%2Fattachments-extra/probe.txt', '/attachments/TP-999/probe.txt', `/attachments/${item.id}/..%2F..%2Fplanestro.yml`, `/attachments/${item.id}/folder`]) {
      expect((await get(path)).status, path).toBe(404);
    }
  });

  it('rejects symlinks when reading, writing, removing, or giving an attachment to an agent', async () => {
    const { store, item, root, get } = await setup();
    const a = store.addManagedAttachment(item.id, 'original.txt', Buffer.from('ok'));
    const outside = join(root, 'outside.txt'); writeFileSync(outside, 'keep me');
    const linked = `attachments/${item.id}/link.txt`;
    symlinkSync(outside, join(store.dataDir, linked));
    expect((await get('/' + linked)).status).toBe(404);
    expect(() => store.attachmentAbsPath({ path: linked, kind: 'managed' })).toThrow();
    store.mutateItem(item.id, [{ set: { attachments: [{ path: linked, kind: 'managed', added_at: new Date().toISOString() }] } }], 'engine');
    expect(() => store.removeAttachment(item.id, linked)).toThrow();
    expect(readFileSync(outside, 'utf8')).toBe('keep me');
    const dir = join(store.attachmentsDir, item.id);
    renameSync(dir, dir + '-original');
    symlinkSync(root, dir, 'dir');
    expect(() => store.addManagedAttachment(item.id, 'new.txt', Buffer.from('bad'))).toThrow();
    expect((await get('/' + a.path)).status).toBe(404);
  });

  it('rejects a symlinked attachment root and forged managed deletion paths', async () => {
    const { store, item, dataDir, root, get } = await setup();
    const outside = join(root, 'outside.txt'); writeFileSync(outside, 'keep me');
    const rel = '../outside.txt';
    store.mutateItem(item.id, [{ set: { attachments: [{ path: rel, kind: 'managed', added_at: new Date().toISOString() }] } }], 'engine');
    expect(() => store.removeAttachment(item.id, rel)).toThrow(/invalid managed/);
    expect(readFileSync(outside, 'utf8')).toBe('keep me');
    renameSync(store.attachmentsDir, join(dataDir, 'original-attachments'));
    symlinkSync(root, store.attachmentsDir, 'dir');
    expect(() => store.addManagedAttachment(item.id, 'x.txt', Buffer.from('bad'))).toThrow();
    expect((await get(`/attachments/${item.id}/x.txt`)).status).toBe(404);
  });
});
