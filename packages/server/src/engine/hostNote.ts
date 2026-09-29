import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';

const NAMES: Record<string, string> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };
const onPath = (cmd: string): boolean => { try { execFileSync('/bin/sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; } catch { return false; } };

/**
 * What a session needs to know about the machine it runs on, from the machine itself rather than
 * from a prompt someone wrote for another one. On macOS there is no GNU `timeout`: HH-121's worker
 * ran `timeout 120 … godot …` for every capture, read the instant "command not found" as a hang, and
 * spent the end of a $269 item chasing it; the orchestrator had suggested `timeout 120` too (dogfood p21).
 */
export function hostNote(os: string = platform(), has: (cmd: string) => boolean = onPath): string {
  const lines = [`## This host`, '', `- Operating system: ${NAMES[os] ?? os}.`];
  if (!has('timeout')) {
    lines.push(`- \`timeout\` is not installed here${has('gtimeout') ? ' (`gtimeout` is)' : ', nor `gtimeout`'}. To bound a long command, use your shell tool's own timeout rather than a wrapper command.`);
  }
  lines.push('- "command not found" (exit code 127) means the tool is missing. It does not mean the command hung or failed: check with `command -v <name>` before retrying.');
  return lines.join('\n');
}

/**
 * What planestro copies into the main checkout on merge (worktrees.copy_to_checkout, #72), said to
 * every session: art briefs asked sandboxed Codex workers to copy their raws into the main checkout's
 * tmp/, which they cannot write, and the orchestrator flagged each such "rescue blocked" as a merge blocker.
 */
export function keptPathsNote(paths: string[], checkout: string, orchestrator = false): string {
  if (!paths.length) return '';
  const where = paths.map((p) => `\`${p.replace(/\/+$/, '')}/\``).join(', ');
  const lines = ['', '', '## Files copied on merge', '', `- Files a worker leaves under ${where} in its worktree are copied by planestro into the same folder of the main checkout (${checkout}) when the item merges, and kept in .displaced/ as well.`];
  lines.push(orchestrator
    ? '- So a worker never copies them there itself, and a worker that reports it could not copy them there is not blocked: it is not a merge blocker. Do not write that step into a plan or instruction.'
    : '- Leave them there; do not copy them into the main checkout yourself, even if a brief says to.');
  return lines.join('\n');
}
