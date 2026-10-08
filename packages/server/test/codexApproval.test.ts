import { expect, it } from 'vitest';
import { commandGrant, commandForms, matchesCommandGrant } from '../src/engine/sessions/nativeApproval.ts';
import { permissionGrantRefusal, rulingText } from '../src/engine/parks.ts';

const req = { tool: 'CodexApproval', input: { method: 'item/commandExecution/requestApproval', command: '/bin/zsh -lc "gh api repos/owner/project/actions/runners"', cwd: '/repo/worktree', environmentId: 'local', availableDecisions: ['accept', 'cancel'] } };
it('binds a one-time grant to the entire command, exact cwd and local environment', () => {
  const grant = commandGrant(req)!;
  expect(grant).toBeDefined();
  expect(matchesCommandGrant(grant, { ...req, input: { ...req.input, turnId: 'new-turn', reason: 'new explanation' } })).toBe(true);
  for (const patch of [{ command: req.input.command + '; touch extra' }, { cwd: '/other' }, { environmentId: 'remote' }, { networkApprovalContext: { host: 'example.test' } }, { additionalPermissions: { network: { enabled: true } } }, { availableDecisions: ['acceptForSession'] }, { method: 'item/fileChange/requestApproval' }, { futureScope: 'session' }]) {
    expect(matchesCommandGrant(grant, { ...req, input: { ...req.input, ...patch } })).toBe(false);
  }
});
it('refuses incomplete requests and permanent grants, and carries the full approved command', () => {
  expect(commandGrant({ ...req, input: { ...req.input, cwd: '' } })).toBeUndefined();
  expect(permissionGrantRefusal(req)).toBeUndefined();
  expect(permissionGrantRefusal(req, 'always')).toContain('only be allowed once');
  const command = 'echo ' + 'long-command '.repeat(1000);
  expect(rulingText({ ...req, input: { ...req.input, command } }, 'allow', 'The user')).toContain(command);
});
it('unwraps only literal shell launchers so policy can inspect their bodies', () => {
  expect(commandForms('/bin/zsh -lc "git push origin worker"')).toEqual(['/bin/zsh -lc "git push origin worker"', 'git push origin worker']);
  expect(commandForms("/bin/zsh -lc 'for n in 1 2; do gh api repos/owner/project/actions/runners; done'")).toHaveLength(2);
  expect(commandForms('/bin/zsh -lc "$UNKNOWN"')).toHaveLength(1);
});
