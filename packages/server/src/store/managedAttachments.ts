import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

import { ID_RE } from '@planestro/shared';
const FILE = /^[A-Za-z0-9._-]+$/;
const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\');
};

/** Managed files never traverse a symlink, even one currently pointing inside the tree. */
export function managedAttachmentPath(dataDir: string, id: string, file: string, create = false): string {
  if (!ID_RE.test(id) || !FILE.test(file) || file === '.' || file === '..') throw new Error('invalid managed attachment path');
  const data = realpathSync(dataDir);
  let dir = data;
  for (const part of ['attachments', id]) {
    dir = join(dir, part);
    if (create && !existsSync(dir)) mkdirSync(dir); // a dangling symlink fails safely here
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !inside(data, realpathSync(dir))) throw new Error('managed attachment directory is not inside the data directory');
  }
  const path = join(dir, file);
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || !inside(dir, realpathSync(path))) throw new Error('managed attachment must be a regular file inside its item directory');
  } catch (e) {
    if (!create || (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  return path;
}

export function managedAttachmentParts(path: string, id?: string): { id: string; file: string } {
  const parts = path.split('/');
  if (parts.length !== 3 || parts[0] !== 'attachments' || (id !== undefined && parts[1] !== id)) throw new Error('invalid managed attachment path');
  return { id: parts[1], file: parts[2] };
}
