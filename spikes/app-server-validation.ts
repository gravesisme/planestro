import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { CodexAppServerPort } from '../packages/server/src/engine/sessions/CodexAppServerPort.ts';
const root = mkdtempSync(join(tmpdir(), 'planestro-appserver-validation-'));
const home = join(root, 'home');
const port = new CodexAppServerPort(process.env.PLANESTRO_CODEX_BIN ?? 'codex', home);
const calls: string[] = [];
const model = process.env.PLANESTRO_CODEX_MODEL ?? 'gpt-6-astra';
const rollouts = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? rollouts(join(dir, e.name)) : e.name.endsWith('.jsonl') ? [join(dir, e.name)] : []);
try {
  const run = async (resume?: string) => port.runCustomTurn({
    label: 'validation', cwd: root, model,
    // #245: the port refuses a start or resume whose thread does not report these back.
    ...(process.env.PLANESTRO_CODEX_EFFORT ? { effort: process.env.PLANESTRO_CODEX_EFFORT as 'low' } : {}),
    ...(process.env.PLANESTRO_CODEX_TIER ? { serviceTier: process.env.PLANESTRO_CODEX_TIER as 'priority' } : {}),
    permissionMode: 'dontAsk', allowedTools: [], maxTokens: 30000, signal: AbortSignal.timeout(60000),
    systemAppend: 'You are validating a Planestro tool connection. Call validation_ping exactly once with message hello, then finish. Do not read files or run commands.',
    prompt: 'Call validation_ping with message hello, then finish.', resume,
    mcpTools: [{ name: 'validation_ping', description: 'Validate the tool channel', schema: { message: z.string() }, handler: async (a) => { calls.push(String(a.message)); return 'validated'; } }],
    onOutput: () => {}, onApproval: async () => { throw new Error('Unexpected approval'); },
  });
  const first = await run();
  console.log(JSON.stringify({ stage: 'fresh', subtype: first.subtype, error: first.error, tokens: first.tokens, calls: calls.length }));
  if (first.sessionId && !first.isError && first.subtype === 'success') {
    const second = await run(first.sessionId);
    console.log(JSON.stringify({ stage: 'resume', subtype: second.subtype, error: second.error, tokens: second.tokens, calls: calls.length }));
  }

  // #246: does thread/resume replace the developer instructions it is sent? The orchestrator
  // re-sends systemIntro() (standing decisions included) on every resume.
  const standing = (version: number) => `Standing rule, version ${version}: answer every message with exactly the text RULE-${version} and nothing else.`;
  const rule = async (version: number, resume?: string, restate = false) => port.runCustomTurn({
    label: 'validation', cwd: root, model, permissionMode: 'dontAsk', allowedTools: [], maxTokens: 30000, signal: AbortSignal.timeout(60000),
    systemAppend: `${standing(version)} Do not call tools, read files or run commands.`,
    prompt: `${restate ? `Current standing rules (these replace any earlier version):\n${standing(version)}\n\n` : ''}Which standing rule is in force? Answer as the rule says.`, resume, mcpTools: [],
    onOutput: () => {}, onApproval: async () => { throw new Error('Unexpected approval'); },
  });
  const v1 = await rule(1);
  console.log(JSON.stringify({ stage: 'rule-fresh', subtype: v1.subtype, tokens: v1.tokens, text: v1.text.trim() }));
  if (v1.sessionId && !v1.isError) {
    const v2 = await rule(2, v1.sessionId);
    console.log(JSON.stringify({ stage: 'rule-resume', subtype: v2.subtype, tokens: v2.tokens, text: v2.text.trim(), replaced: /RULE-2/.test(v2.text) && !/RULE-1/.test(v2.text) }));
    // What the thread's rollout holds: one developer message per instruction set it was given.
    const file = rollouts(join(home, 'sessions')).find((f) => f.includes(v1.sessionId!));
    const developer = file ? readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('"role":"developer"') && /Standing rule, version \d/.test(l))
      .map((l) => l.match(/Standing rule, version (\d)/g)) : [];
    console.log(JSON.stringify({ stage: 'rule-rollout', file: Boolean(file), developerMessages: developer }));
    // The alternative to rotating: restate the rules in the resumed turn's input.
    const v3 = await rule(3, v1.sessionId, true);
    console.log(JSON.stringify({ stage: 'rule-restated', subtype: v3.subtype, tokens: v3.tokens, text: v3.text.trim(), followed: /RULE-3/.test(v3.text) }));
  }
} finally { if (!process.env.KEEP) rmSync(root, { recursive: true, force: true }); else console.log(root); }
