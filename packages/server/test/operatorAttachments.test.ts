import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DataStore } from '../src/store/DataStore.ts';
import { MockEngine } from '../src/engine/MockEngine.ts';
import { operatorServer } from '../src/routes/mcp.ts';
import { readMcpAttachments } from '../src/routes/mcpAttachments.ts';
import { makeFixture } from './helpers.ts';

// #555: a Claude Code session files a bug with its screenshot in one call. The file is checked (type by name and by
// contents, size, no symlink, no `..`) before anything is written, then copied into the item's managed attachments.

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);
const text = (r: any) => JSON.parse(r.content[0].text);

let store: DataStore | undefined; let client: Client | undefined;
afterEach(async () => { await client?.close(); store?.close(); store = undefined; client = undefined; });

async function setup(local = true) {
  const { dataDir } = makeFixture();
  store = await DataStore.open(dataDir, { emit: () => {} });
  store.updateConfig((d) => { d.setIn(['operator_mcp', 'allow_writes'], true); d.setIn(['attachments', 'image_max_bytes'], 1000); d.setIn(['attachments', 'managed_max_bytes'], 500); });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await operatorServer(store, new MockEngine(store, () => {}), { local }).connect(a);
  client = new Client({ name: 'operator-test', version: '1' });
  await client.connect(b);
  return { store, client };
}
const scratch = () => mkdtempSync(join(tmpdir(), 'planestro-555-'));

describe('files an operator MCP client attaches (#555)', () => {
  it('create_item files the item with its screenshot in one call: a managed attachment the page and the prompts show', async () => {
    const { store, client } = await setup();
    const dir = scratch();
    writeFileSync(join(dir, 'road seam.png'), PNG);
    const made = text(await client.callTool({ name: 'create_item', arguments: { title: 'Road borders overlap', description: 'See the screenshot.', attachments: [{ path: join(dir, 'road seam.png') }] } }));
    const fm = store.requireItem(made.id).file.frontmatter;
    expect(fm.attachments).toHaveLength(1);
    expect(fm.attachments[0]).toMatchObject({ kind: 'managed', path: expect.stringMatching(new RegExp(`^attachments/${made.id}/\\d{8}-\\d{6}-road-seam\\.png$`)) });
    expect(made.attachments).toEqual([fm.attachments[0].path]);
    const abs = store.attachmentAbsPath(fm.attachments[0]);
    expect(readFileSync(abs).equals(PNG)).toBe(true);
    // Recorded as the operator's, not the user's.
    expect(store.requireItem(made.id).file.sections.find((s) => s.title === 'Activity')!.body).toMatch(/\[operator\] attached attachments\//);
    // The planner's and worker's system prompt (worker-system's {{attachments}}) lists it by its absolute path.
    expect(store.promptContext(store.requireItem(made.id)).attachments).toBe(`${abs} (managed)`);

    // Later, as data (what the plugin's bridge sends): attach_file adds to the same item.
    const more = text(await client.callTool({ name: 'attach_file', arguments: { id: made.id, attachments: [{ data: PNG.toString('base64'), name: 'after.png' }] } }));
    expect(more.attachments).toEqual([expect.stringMatching(/-after\.png$/)]);
    expect(store.requireItem(made.id).file.frontmatter.attachments).toHaveLength(2);
  });

  it('refuses a symlink, a path that climbs with .., a relative path, an oversized file and an unsupported type, and files nothing', async () => {
    const { store, client } = await setup();
    const dir = scratch();
    writeFileSync(join(dir, 'real.png'), PNG);
    symlinkSync(join(dir, 'real.png'), join(dir, 'link.png'));
    writeFileSync(join(dir, 'big.png'), Buffer.concat([PNG, Buffer.alloc(2000)]));
    writeFileSync(join(dir, 'notes.svg'), '<svg/>');
    writeFileSync(join(dir, 'fake.png'), 'not a png at all');
    const before = store.listItems().length;
    const refused = async (attachment: object, why: RegExp) => {
      const r = await client.callTool({ name: 'create_item', arguments: { title: 'Bug', attachments: [attachment] } });
      expect(r.isError, JSON.stringify(attachment)).toBe(true);
      expect(text(r).error).toMatch(why);
    };
    await refused({ path: join(dir, 'link.png') }, /symlink/);
    await refused({ path: `${dir}/../${dir.split('/').pop()}/real.png` }, /\.\./);
    await refused({ path: 'real.png' }, /absolute/);
    await refused({ path: join(dir, 'big.png') }, /over attachments\.image_max_bytes/);
    await refused({ path: join(dir, 'notes.svg') }, /not a type/);
    await refused({ path: join(dir, 'fake.png') }, /not a PNG/);
    await refused({ path: join(dir, 'missing.png') }, /no such file/);
    // A name is never a path: the copy cannot land outside the item's folder.
    await refused({ path: join(dir, 'real.png'), name: '../../planestro.png' }, /one plain file name/);
    await refused({ data: PNG.toString('base64'), name: '../x.png' }, /one plain file name/);
    await refused({ data: Buffer.alloc(3000).toString('base64'), name: 'big.png' }, /over attachments\.image_max_bytes/);
    await refused({ data: PNG.toString('base64') }, /needs a name/);
    await refused({ path: join(dir, 'real.png'), data: PNG.toString('base64') }, /either path or data/);
    // A PDF is a document: the smaller managed_max_bytes applies.
    writeFileSync(join(dir, 'doc.pdf'), Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(600)]));
    await refused({ path: join(dir, 'doc.pdf') }, /over attachments\.managed_max_bytes/);
    // One bad file refuses the whole call: no item filed without its screenshot.
    await refused({ path: join(dir, 'link.png') }, /symlink/);
    expect(store.listItems().length).toBe(before);
    expect(existsSync(join(store.dataDir, 'attachments')) ? readdirSync(join(store.dataDir, 'attachments')) : []).toEqual([]);
    // attach_file refuses the same way, and on an item that is not there.
    const item = store.createItem({ title: 'Existing' });
    expect((await client.callTool({ name: 'attach_file', arguments: { id: item.id, attachments: [{ path: join(dir, 'link.png') }] } })).isError).toBe(true);
    expect((await client.callTool({ name: 'attach_file', arguments: { id: 'TP-999', attachments: [{ path: join(dir, 'real.png') }] } })).isError).toBe(true);
    expect(store.requireItem(item.id).file.frontmatter.attachments).toEqual([]);
  });

  it('a caller on another machine sends bytes: the server never reads a path for it', async () => {
    const { client, store } = await setup(false);
    const dir = scratch();
    writeFileSync(join(dir, 'shot.png'), PNG);
    const r = await client.callTool({ name: 'create_item', arguments: { title: 'Remote', attachments: [{ path: join(dir, 'shot.png') }] } });
    expect(r.isError).toBe(true);
    expect(text(r).error).toMatch(/another machine; send the file's bytes as data/);
    const ok = text(await client.callTool({ name: 'create_item', arguments: { title: 'Remote', attachments: [{ data: PNG.toString('base64'), name: 'shot.png' }] } }));
    expect(store.requireItem(ok.id).file.frontmatter.attachments).toHaveLength(1);
  });

  it('judges each type by its contents as well as its name', () => {
    const limits = { managed_max_bytes: 10_000, image_max_bytes: 10_000 };
    const ok = (name: string, data: Buffer) => readMcpAttachments([{ data: data.toString('base64'), name }], { local: false, limits })[0].name;
    expect(ok('a.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('a.jpg');
    expect(ok('a.JPEG', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('a.JPEG');
    expect(ok('a.gif', Buffer.from('GIF89a......'))).toBe('a.gif');
    expect(ok('a.webp', Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('a.webp');
    expect(ok('a.pdf', Buffer.from('%PDF-1.4\n'))).toBe('a.pdf');
    expect(() => ok('a.webp', PNG)).toThrow(/not a WebP/);
    expect(() => ok('a.html', Buffer.from('<html>'))).toThrow(/not a type/);
    expect(() => ok('.png', PNG)).toThrow(/plain file name/);
  });
});
