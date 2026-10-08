import { isAbsolute } from 'node:path';
import type { PermissionRequest } from '../ports.ts';
import { literal, readShell } from '../shell.ts';

/** A single local command, never a session, prefix, network-host or filesystem grant. */
export interface CommandGrant { command: string; cwd: string; environmentId: 'local' }

const FIELDS = new Set(['method', 'kind', 'threadId', 'turnId', 'itemId', 'startedAtMs', 'environmentId', 'reason', 'command', 'cwd', 'commandActions', 'proposedExecpolicyAmendment', 'availableDecisions']);

/** Fail closed on new permission-bearing protocol fields, remote execution and incomplete previews. */
export function commandGrant(req: PermissionRequest): CommandGrant | undefined {
  if (req.tool !== 'CodexApproval') return;
  const p = req.input;
  if (p.method !== 'item/commandExecution/requestApproval' || Object.keys(p).some((k) => !FIELDS.has(k) && p[k] != null)) return;
  if (p.kind != null && p.kind !== 'command') return;
  if (p.environmentId != null && p.environmentId !== 'local') return;
  if (typeof p.command !== 'string' || !p.command.trim() || typeof p.cwd !== 'string' || !isAbsolute(p.cwd)) return;
  if (p.availableDecisions != null && (!Array.isArray(p.availableDecisions) || !p.availableDecisions.includes('accept'))) return;
  return { command: p.command, cwd: p.cwd, environmentId: 'local' };
}

export function matchesCommandGrant(grant: CommandGrant, req: PermissionRequest): boolean {
  const next = commandGrant(req);
  return !!next && next.command === grant.command && next.cwd === grant.cwd && next.environmentId === grant.environmentId;
}

/** Codex displays the shell launcher as well as its command. Apply worker hard denials to both. */
export function commandForms(command: string): string[] {
  const forms = [command];
  for (let depth = 0; depth < 4; depth++) {
    const parts = readShell(forms[forms.length - 1]);
    if (parts?.length !== 1 || parts[0].kind !== 'command') break;
    const words = parts[0].words.map(literal);
    if (words.length !== 3 || !/^(?:\/[^\s]+\/)?(?:bash|zsh|sh)$/.test(words[0] ?? '') || !/^-[a-z]*c[a-z]*$/.test(words[1] ?? '') || words[2] === null) break;
    forms.push(words[2]);
  }
  return forms;
}

export function nativeApprovalGuidance(tool: unknown): string | undefined {
  if (tool !== 'CodexApproval') return;
  return 'For a supported local Codex command, allow saves a one-time grant for the exact command and working directory. The next matching native request receives accept after the grant is consumed. No process waits for you, no permanent rule is added, and the sandbox for other commands is unchanged. Broader network, filesystem and session grants remain unsupported. Review the entire command, including loops and shell bodies; hard worker denials are checked again when you approve.';
}
