import { copyFileSync, lstatSync, readFileSync, readlinkSync, symlinkSync, constants as fsConstants, type Stats } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';

/**
 * Copying and moving the files of a worktree, one entry at a time (#581). A symbolic link is an entry like a file:
 * listed, moved and copied as the link it is (the same target text), never followed, never read through and never
 * written through. Every copy is exclusive: it fails rather than replace what is at the destination.
 */

/** The entry at `path` itself, a dangling link included (`existsSync` follows links and calls that one missing). */
export function lstatOrNull(path: string): Stats | null {
  try { return lstatSync(path); } catch { return null; }
}

/** Copy one file or link to `to`, where nothing may be yet. A link is recreated with its target text, checked after. */
export function copyEntry(from: string, to: string): void {
  const st = lstatSync(from);
  if (st.isSymbolicLink()) {
    const target = readlinkSync(from);
    symlinkSync(target, to);   // EEXIST over anything, a link included: never through one
    if (readlinkSync(to) !== target) throw new Error(`link ${to} points to ${readlinkSync(to)}, not ${target}`);
    return;
  }
  if (!st.isFile()) throw new Error(`${from} is neither a file nor a link`);
  copyFileSync(from, to, fsConstants.COPYFILE_EXCL);
  const size = lstatSync(to).size;
  if (size !== st.size) throw new Error(`copy of ${from} is ${size} bytes, not ${st.size}`);
}

/** How an entry of the source compares with what is at its path in the destination. */
export type Against = 'absent' | 'identical' | 'different';

/**
 * `from` (a file or a link) against `to`, neither followed: a link equals a link with the same target text, a file a
 * file with the same bytes; a link where a file is, or the reverse, or a folder, is different.
 */
export function compareEntry(from: string, to: string): Against {
  const there = lstatOrNull(to);
  if (!there) return 'absent';
  const st = lstatSync(from);
  if (st.isSymbolicLink()) return there.isSymbolicLink() && readlinkSync(to) === readlinkSync(from) ? 'identical' : 'different';
  if (!there.isFile() || there.size !== st.size) return 'different';
  return readFileSync(to).equals(readFileSync(from)) ? 'identical' : 'different';
}

/**
 * Whether the relative path `rel` can be created under `root` through real folders only: false when it leaves `root`,
 * or when a folder on the way exists as a link or a file (creating under a link would write wherever it points).
 */
export function staysInside(root: string, rel: string): boolean {
  const base = resolve(root); const to = resolve(base, rel);
  if (to === base || !to.startsWith(base + sep)) return false;
  for (let dir = dirname(to); dir !== base; dir = dirname(dir)) {
    const st = lstatOrNull(dir);
    if (st && !st.isDirectory()) return false;
  }
  return true;
}

/**
 * The Python virtual environments among `files` (relative paths): each folder that holds a `pyvenv.cfg`. A venv
 * records absolute paths to where it was made, so a copy of one is broken once that folder is gone (#581).
 */
export function venvRoots(files: string[]): string[] {
  const roots = [...new Set(files.filter((f) => basename(f) === 'pyvenv.cfg' && f.includes('/')).map((f) => dirname(f)))].sort();
  return roots.filter((r) => !roots.some((o) => o !== r && r.startsWith(`${o}/`)));
}

/** Whether `file` is in one of the folders `roots`. */
export function isUnder(file: string, roots: string[]): boolean {
  return roots.some((r) => file.startsWith(`${r}/`));
}
