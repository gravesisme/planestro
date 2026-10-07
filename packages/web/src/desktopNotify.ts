import type { JournalEntry } from '@planestro/shared';

/**
 * Desktop notifications from this browser (#70): the server journals a `notification` for a merge, a usage
 * pause or a wait on you (#224), and an open planestro tab on a device that opted in shows it. Installed as an app (Chrome's Install
 * planestro), macOS files it under planestro's own name and icon; in a plain tab, under the browser's. The
 * choice is per device (localStorage), since the permission is too. A native helper is not used: on macOS 26 an
 * ad-hoc-signed one is never allowed to notify (server/src/notifier.ts).
 */
const KEY = 'planestro.notify.desktop';
export const desktopSupported = () => typeof window !== 'undefined' && 'Notification' in window;
export function desktopWanted(): boolean { try { return localStorage.getItem(KEY) === 'on'; } catch { return false; } }
export function setDesktopWanted(on: boolean): void { try { if (on) localStorage.setItem(KEY, 'on'); else localStorage.removeItem(KEY); } catch { /* a private window: off */ } }

/** Ask for the permission, and remember the choice when it is given. Returns the browser's answer. */
export async function enableDesktop(): Promise<NotificationPermission | 'unsupported'> {
  if (!desktopSupported()) return 'unsupported';
  const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  setDesktopWanted(p === 'granted');
  return p;
}

/**
 * Show a journaled notification, once: the tag is its timestamp, so several open tabs replace each other's
 * instead of stacking. Anything else, or a device that did not opt in, shows nothing.
 */
export function showIfNotification(e: JournalEntry | undefined, open: (title: string, opts: NotificationOptions) => unknown = (t, o) => new Notification(t, o)): boolean {
  if (e?.type !== 'notification' || !desktopWanted() || !desktopSupported() || Notification.permission !== 'granted') return false;
  const title = String(e.data?.title ?? 'planestro'); const body = String(e.data?.message ?? '');
  try { open(title, { body, icon: '/icon-192.png', badge: '/icon-192.png', tag: `planestro-${e.ts}`, data: { item: e.item } }); return true; } catch { return false; }
}
