import { execFile } from 'node:child_process';

/**
 * A desktop notification from the shell (`planestro notify <title> <message>`, #70): osascript on a Mac,
 * notify-send on Linux, nothing elsewhere. It never throws: a notification that cannot be shown is not an
 * error for whatever wanted to send it.
 *
 * Not a native macOS sender: a helper app (bundle dev.planestro.notify, UNUserNotificationCenter, ad-hoc
 * signed, installed in ~/Applications) got no permission prompt and was never listed under Notifications
 * on macOS 26.7 — every request came back UNErrorDomain Code=1 "Notifications are not allowed", and the
 * legacy NSUserNotificationCenter delivered nothing. A sender under planestro's own icon needs a Developer
 * ID signature. The installed web app gets that icon instead: see the web's desktopNotify.
 */
export type Run = (file: string, args: string[]) => Promise<{ code: number }>;

const run: Run = (file, args) => new Promise((resolve) => {
  execFile(file, args, { timeout: 15_000 }, (e) => resolve({ code: e ? (typeof (e as NodeJS.ErrnoException).code === 'number' ? Number((e as NodeJS.ErrnoException).code) : 1) : 0 }));
});

/** AppleScript string literal: backslashes and quotes escaped, line breaks as spaces. */
export const appleString = (s: string) => `"${s.replace(/\s*\n\s*/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export async function desktopNotify(title: string, message: string, deps: { platform?: NodeJS.Platform; run?: Run } = {}): Promise<'osascript' | 'notify-send' | 'none'> {
  const platform = deps.platform ?? process.platform; const exec = deps.run ?? run;
  try {
    if (platform === 'darwin') return (await exec('osascript', ['-e', `display notification ${appleString(message)} with title ${appleString(title)}`])).code === 0 ? 'osascript' : 'none';
    if (platform === 'linux') return (await exec('notify-send', ['--app-name=planestro', title, message])).code === 0 ? 'notify-send' : 'none';
  } catch { /* nothing to show it with */ }
  return 'none';
}
