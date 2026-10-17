import { openSync, writeSync, fsyncSync, closeSync, renameSync, mkdirSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';

let counter = 0;

/** Write via a sibling temp file + fsync + rename so readers never see a partial file. */
export function atomicWrite(path: string, data: string | Buffer, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${++counter}`);
  const fd = openSync(tmp, 'wx', mode);
  try {
    // writeSync may write less than it was given: what it wrote is counted and the rest written.
    const buf = typeof data === 'string' ? Buffer.from(data) : data;
    for (let off = 0; off < buf.length;) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
  } catch (e) { closeSync(fd); try { unlinkSync(tmp); } catch { /* already gone */ } throw e; }
  closeSync(fd);
  renameSync(tmp, path);
}

/** Delete temp files left by a crash mid-write. */
export function cleanStaleTemps(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(dir)) {
    if (/^\..+\.tmp-\d+-\d+$/.test(name)) { unlinkSync(join(dir, name)); removed.push(name); }
  }
  return removed;
}
