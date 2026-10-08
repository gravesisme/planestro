import { expect, it } from 'vitest';
import { commandGrant, commandGrantGap, commandForms, matchesCommandGrant } from '../src/engine/sessions/nativeApproval.ts';
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
it('says why a Codex approval cannot be allowed, before anyone is offered allow (#297)', () => {
  expect(commandGrantGap(req)).toBeUndefined();
  expect(commandGrantGap({ ...req, input: { ...req.input, additionalPermissions: { network: { enabled: true } } } })).toBe('the request also asks for additional sandbox permissions');
  expect(commandGrantGap({ ...req, input: { ...req.input, networkApprovalContext: { host: 'example.test' } } })).toBe('the request also asks for network access');
  expect(commandGrantGap({ tool: 'CodexApproval', input: { method: 'item/fileChange/requestApproval' } })).toBe('Codex asked to approve a file change, not a command');
  expect(commandGrantGap({ tool: 'CodexApproval', input: { method: 'item/permissions/requestApproval' } })).toBe('Codex asked to widen the sandbox itself, not to run one command');
  expect(commandGrantGap({ ...req, input: { ...req.input, environmentId: 'remote' } })).toBe('it would run in the remote environment, not on this machine');
  expect(commandGrantGap({ ...req, input: { ...req.input, cwd: '' } })).toBe('Codex did not show the complete command and its working directory');
  expect(commandGrantGap({ ...req, input: { ...req.input, availableDecisions: ['cancel'] } })).toBe('Codex does not offer a one-time accept for it');
  expect(permissionGrantRefusal({ ...req, input: { ...req.input, networkApprovalContext: { host: 'example.test' } } })).toBe("These Codex sandbox permissions cannot be granted here: the request also asks for network access. planestro allows only one complete local command, once, and never widens a turn's sandbox; there is no setting that grants more. Deny it and say what to do instead (a command that needs no more than the sandbox gives), or take the item over, do it yourself and hand it back.");
});
