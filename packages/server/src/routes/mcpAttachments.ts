import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { z } from 'zod';
import { managedLimit } from '@planestro/shared';

// ---- files an operator MCP client puts on an item (#555) ----
// A screenshot of a bug, filed with the item in one call (`create_item`) or added later (`attach_file`). Each file is
// either a local `path` the server reads (an MCP client on this machine) or its bytes as base64 `data` (any client: the
// plugin's stdio bridge reads a path on the client's machine and sends the bytes, so a server reached over the network
// never needs to read a path that is not its own). Everything is checked before anything is written; the copy then goes
// through `DataStore.addManagedAttachment`, as a file attached on the board does.

/** At most this many files in one call. */
export const MCP_ATTACH_MAX = 8;

/** What an MCP client may attach: pictures a model can see, and PDFs; each judged by its name and its first bytes. */
const TYPES: { kind: string; ext: RegExp; magic: (b: Buffer) => boolean }[] = [
  { kind: 'PNG', ext: /\.png$/i, magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { kind: 'JPEG', ext: /\.jpe?g$/i, magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { kind: 'GIF', ext: /\.gif$/i, magic: (b) => ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1')) },
  { kind: 'WebP', ext: /\.webp$/i, magic: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { kind: 'PDF', ext: /\.pdf$/i, magic: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
];
const TYPES_SAID = 'PNG, JPEG, WebP, GIF or PDF';

export const McpAttachment = z.object({
  path: z.string().min(1).optional().describe('Absolute path of a file on the machine running this MCP client (the planestro plugin sends its bytes; a client on the server\'s own machine may send just the path)'),
  data: z.string().min(1).optional().describe('The file\'s bytes, base64, instead of path (needs name)'),
  name: z.string().min(1).max(120).optional().describe('File name to keep it under, with its extension (.png, .jpg, .webp, .gif, .pdf); omitted, the path\'s own'),
});
export type McpAttachmentInput = z.infer<typeof McpAttachment>;
export const McpAttachments = z.array(McpAttachment).max(MCP_ATTACH_MAX)
  .describe(`Up to ${MCP_ATTACH_MAX} files to put on the item (a bug's screenshot, a PDF): ${TYPES_SAID}, within attachments.image_max_bytes (pictures) or managed_max_bytes. The planner and worker see them.`);

export interface AttachLimits { managed_max_bytes: number; image_max_bytes?: number }
export interface AttachContext {
  /** Whether the request came from this machine: only then is a `path` the server's to read. */
  local: boolean;
  limits: AttachLimits;
}

const limitName = (limits: AttachLimits, max: number) => (max === limits.managed_max_bytes ? 'managed_max_bytes' : 'image_max_bytes');

/** A name to keep the copy under: one plain file name, never a path, and of a type attachments take. */
function checkName(name: string): void {
  if (/[/\\\0]/.test(name) || name === '.' || name === '..' || name.startsWith('.')) throw new Error(`${JSON.stringify(name)}: a name is one plain file name, with no folder or leading dot`);
  if (!TYPES.some((t) => t.ext.test(name))) throw new Error(`${name}: not a type an item takes from here (${TYPES_SAID})`);
}

function checkBytes(name: string, data: Buffer, limits: AttachLimits): void {
  const max = managedLimit(limits, name);
  if (data.length > max) throw new Error(`${name}: ${data.length} bytes, over attachments.${limitName(limits, max)} (${max})`);
  const type = TYPES.find((t) => t.ext.test(name))!;
  if (!type.magic(data)) throw new Error(`${name}: its contents are not a ${type.kind} file`);
}

/** Read a local file that is no symlink, judged on the file descriptor it opened (O_NOFOLLOW): no swap between check and read. */
function readLocal(path: string, name: string, limits: AttachLimits): Buffer {
  if (!isAbsolute(path)) throw new Error(`${path}: give an absolute path`);
  if (path.split(/[/\\]/).includes('..')) throw new Error(`${path}: a path may not climb out of a folder with ..`);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0)); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') throw new Error(`${path}: is a symlink; attach the file it points to`);
    if (code === 'ENOENT') throw new Error(`${path}: no such file`);
    throw new Error(`${path}: cannot be read (${code ?? (e as Error).message})`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${path}: not a regular file`);
    const max = managedLimit(limits, name);
    if (st.size > max) throw new Error(`${name}: ${st.size} bytes, over attachments.${limitName(limits, max)} (${max})`);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) { const n = readSync(fd, buf, off, st.size - off, off); if (!n) break; off += n; }
    return buf.subarray(0, off);
  } finally { closeSync(fd); }
}

function decode(name: string, data: string, limits: AttachLimits): Buffer {
  const b64 = data.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 === 1) throw new Error(`${name}: data is not base64`);
  const max = managedLimit(limits, name);
  // Judged before decoding, so an oversized upload is never held twice.
  const size = Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
  if (size > max) throw new Error(`${name}: ${size} bytes, over attachments.${limitName(limits, max)} (${max})`);
  return Buffer.from(b64, 'base64');
}

/** Every file checked and read, or the first refusal thrown: nothing is written until all of them pass. */
export function readMcpAttachments(inputs: McpAttachmentInput[] | undefined, ctx: AttachContext): { name: string; data: Buffer }[] {
  if (!inputs?.length) return [];
  if (inputs.length > MCP_ATTACH_MAX) throw new Error(`at most ${MCP_ATTACH_MAX} attachments in one call`);
  return inputs.map((a) => {
    if ((a.path === undefined) === (a.data === undefined)) throw new Error('each attachment gives either path or data, not both');
    const name = a.name ?? (a.path !== undefined ? basename(a.path) : undefined);
    if (!name) throw new Error('an attachment sent as data needs a name');
    checkName(name);
    let data: Buffer;
    if (a.data !== undefined) data = decode(name, a.data, ctx.limits);
    else {
      // A path on someone else's machine is not this server's to read, and reading this server's own files for a remote caller is not allowed either.
      if (!ctx.local) throw new Error(`${a.path}: this server cannot read a path for a client on another machine; send the file's bytes as data (the planestro plugin's bridge does this for you)`);
      data = readLocal(a.path!, name, ctx.limits);
    }
    checkBytes(name, data, ctx.limits);
    return { name, data };
  });
}
