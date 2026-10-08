import type { ProjectRow } from './api.ts';

const ANY_HOST = new Set(['0.0.0.0', '::']);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Where to open a project: this one in place; another on the name this page was reached by, when it listens on every interface. */
export function projectHref(p: ProjectRow, here: { protocol: string; hostname: string } = location): string | undefined {
  if (p.self) return '/';
  if (!p.port || !p.url) return undefined;
  if (p.host && ANY_HOST.has(p.host) && !LOOPBACK.has(here.hostname)) return `${here.protocol}//${here.hostname}:${p.port}/`;
  return `${p.url}/`;
}
