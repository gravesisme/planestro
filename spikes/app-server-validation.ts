import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { CodexAppServerPort } from '../packages/server/src/engine/sessions/CodexAppServerPort.ts';
const root = mkdtempSync(join(tmpdir(), 'planestro-appserver-validation-'));
const home = join(root, 'home');
const port = new CodexAppServerPort(process.env.PLANESTRO_CODEX_BIN ?? 'codex', home);
const calls: string[] = [];
try {
  const run = async (resume?: string) => port.runCustomTurn({
    label: 'validation', cwd: root, model: process.env.PLANESTRO_CODEX_MODEL ?? 'gpt-6-astra',
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
} finally { rmSync(root, { recursive: true, force: true }); }

