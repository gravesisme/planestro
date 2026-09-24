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
