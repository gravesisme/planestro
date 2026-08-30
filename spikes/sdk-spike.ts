/**
 * Phase 0 SDK spike — validates every Agent SDK assumption the planestro engine depends on.
 * Each subcommand is a separate process so "resume across a full restart" is real.
 *
 *   npx tsx spikes/sdk-spike.ts plan            (a)(b)      plan mode + MCP submit_plan + ExitPlanMode intercept, park
 *   npx tsx spikes/sdk-spike.ts resume-impl     (c)(d)(j)   resume as opus/acceptEdits in a NEW process, recall codeword, AskUserQuestion park
 *   npx tsx spikes/sdk-spike.ts resume-answer   (d)(e)      resume with the answer + allowedTools pre-approval; unknown Bash → park
 *   npx tsx spikes/sdk-spike.ts kill            (f)(h)      long turn, find child via `claude agents --json`, SIGTERM it
 *   npx tsx spikes/sdk-spike.ts resume-after-kill (f)       resume the torn session
 *   npx tsx spikes/sdk-spike.ts sessions        (g)         listSessions/getSessionInfo + transcript path
 *   npx tsx spikes/sdk-spike.ts budget          (i)         maxTurns / maxBudgetUsd result subtypes
 *
 * State lives in spikes/out/state.json; a human-readable log in spikes/out/log.md.
 */
import { query, tool, createSdkMcpServer, listSessions, getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(import.meta.dirname, 'out');
mkdirSync(OUT, { recursive: true });
const STATE = join(OUT, 'state.json');
const LOG = join(OUT, 'log.md');
const CWD = process.env.SPIKE_CWD ?? '/Users/dgraves/Projects/hurricane-harrison-godot/.claude/worktrees/planestro-spike';
const PLANNER = process.env.SPIKE_PLANNER ?? 'claude-fable-5';
const IMPLEMENTER = process.env.SPIKE_IMPLEMENTER ?? 'claude-opus-5';
const CODEWORD = 'PELICAN-42';

type State = { session_id?: string; plan?: string; questions?: unknown; killed_session?: string };
const state: State = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
const log = (s: string) => { console.log(s); appendFileSync(LOG, s + '\n'); };
const stamp = () => new Date().toISOString();

function summarize(m: SDKMessage): string {
  if (m.type === 'system' && (m as any).subtype === 'init') return `init session=${(m as any).session_id} model=${(m as any).model} mode=${(m as any).permissionMode} tools=${((m as any).tools ?? []).filter((t: string) => t.startsWith('mcp__')).join(',') || '(no mcp tools)'}`;
  if (m.type === 'assistant') {
    const parts = ((m as any).message?.content ?? []).map((c: any) => c.type === 'text' ? `text:"${c.text.slice(0, 160).replace(/\n/g, ' ')}"` : c.type === 'tool_use' ? `tool_use:${c.name}(${JSON.stringify(c.input).slice(0, 120)})` : c.type);
    return `assistant ${parts.join(' | ')}`;
  }
  if (m.type === 'user') {
    const parts = ((m as any).message?.content ?? []).map((c: any) => c.type === 'tool_result' ? `tool_result:${String(typeof c.content === 'string' ? c.content : JSON.stringify(c.content)).slice(0, 120)}` : c.type);
    return `user ${parts.join(' | ')}`;
  }
  if (m.type === 'result') return `RESULT subtype=${(m as any).subtype} session=${(m as any).session_id} turns=${(m as any).num_turns} cost=$${(m as any).total_cost_usd?.toFixed?.(4)} is_error=${(m as any).is_error} result="${String((m as any).result ?? '').slice(0, 300).replace(/\n/g, ' ')}"`;
  return `${m.type}${(m as any).subtype ? '/' + (m as any).subtype : ''}`;
}

async function run(label: string, q: ReturnType<typeof query>): Promise<{ sessionId?: string; subtype?: string; text: string; threw?: string }> {
  log(`\n## ${label} — ${stamp()}`);
  let sessionId: string | undefined; let subtype: string | undefined; let text = ''; let threw: string | undefined;
  try {
    for await (const m of q) {
      log('- ' + summarize(m));
      if (m.type === 'system' && (m as any).subtype === 'init') sessionId = (m as any).session_id;
      if (m.type === 'assistant') for (const c of (m as any).message?.content ?? []) if (c.type === 'text') text += c.text + '\n';
      if (m.type === 'result') { subtype = (m as any).subtype; sessionId = (m as any).session_id ?? sessionId; }
    }
  } catch (e) {
    // The SDK throws after yielding an error result (error_max_turns, error_max_budget_usd, ...). Engine must catch.
    threw = String(e).slice(0, 200); log(`  query() threw after the error result: ${threw}`);
  }
  return { sessionId, subtype, text, threw };
}

const planestroServer = createSdkMcpServer({
  name: 'planestro',
  version: '0.0.0',
  tools: [
    tool('submit_plan', 'Submit the implementation plan to planestro. Call this once your plan is complete, then end your turn.',
      { plan: z.string().describe('The plan in markdown') },
      async ({ plan }) => { state.plan = plan; save(); log(`  [mcp] submit_plan received ${plan.length} chars`); return { content: [{ type: 'text', text: 'Plan recorded by planestro. End your turn now; you will be resumed when it is approved.' }] }; }),
    tool('report_done', 'Report that the requested work is complete.',
      { summary: z.string() },
      async ({ summary }) => { log(`  [mcp] report_done: ${summary}`); return { content: [{ type: 'text', text: 'Recorded.' }] }; }),
  ],
});

function canUseToolLogger(park: (tool: string, input: any) => { behavior: 'allow'; updatedInput: any } | { behavior: 'deny'; message: string } | null) {
  return async (toolName: string, input: Record<string, unknown>, _opts: any) => {
    log(`  [canUseTool] ${toolName} ${JSON.stringify(input).slice(0, 200)}`);
    const decision = park(toolName, input);
    if (decision) { log(`  [canUseTool] → ${decision.behavior}${'message' in decision ? ': ' + decision.message : ''}`); return decision; }
    log('  [canUseTool] → allow (default)');
    return { behavior: 'allow' as const, updatedInput: input };
  };
}

const cmd = process.argv[2];
const cliVersion = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();
const sdkVersion = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')).version;
log(`\n# spike ${cmd} · claude ${cliVersion} · sdk ${sdkVersion} · cwd ${CWD}`);

if (cmd === 'plan') {
  const r = await run('plan (fable, plan mode, MCP submit_plan)', query({
    prompt: `You are doing a tiny planning exercise. Remember this codeword for later: ${CODEWORD}. Read the header comment of tools/run_checks.sh, then write a 3-bullet plan for adding a "--version" flag that prints the script's own version. Submit the plan by calling the planestro submit_plan tool (do NOT use ExitPlanMode), then end your turn immediately.`,
    options: {
      cwd: CWD, model: PLANNER, permissionMode: 'plan',
      mcpServers: { planestro: planestroServer },
      allowedTools: ['mcp__planestro__submit_plan', 'Read', 'Grep', 'Glob'],
      canUseTool: canUseToolLogger((t, input) => t === 'ExitPlanMode' ? (state.plan = String((input as any).plan ?? ''), save(), { behavior: 'deny', message: 'Plan recorded by planestro (captured from ExitPlanMode). End your turn now.' }) : null),
    },
  }));
  state.session_id = r.sessionId; save();
  log(`\n(a) MCP tool reachable in plan mode: ${state.plan ? 'PASS' : 'FAIL'} (plan ${state.plan?.length ?? 0} chars)`);
  log(`(b) turn ended, subtype=${r.subtype}, session_id=${r.sessionId}: ${r.sessionId && r.subtype === 'success' ? 'PASS' : 'CHECK'}`);
}

if (cmd === 'resume-impl') {
  if (!state.session_id) throw new Error('run plan first');
  const r = await run('resume-impl (NEW process, opus, acceptEdits)', query({
    prompt: `Your plan was approved. First, tell me the codeword I gave you earlier (just the codeword). Then use the AskUserQuestion tool to ask me whether the flag should print "short" or "long" output — do not guess. After the question tool returns, end your turn.`,
    options: {
      cwd: CWD, model: IMPLEMENTER, permissionMode: 'acceptEdits', resume: state.session_id,
      mcpServers: { planestro: planestroServer },
      allowedTools: ['mcp__planestro__report_done', 'Read', 'Grep', 'Glob'],
      canUseTool: canUseToolLogger((t, input) => t === 'AskUserQuestion' ? (state.questions = (input as any).questions, save(), { behavior: 'deny', message: 'Questions recorded by planestro. End your turn now; you will be resumed with the answers.' }) : null),
    },
  }));
  log(`\n(j) context survived full restart (codeword recalled): ${r.text.includes(CODEWORD) ? 'PASS' : 'FAIL'}`);
  log(`(c) resumed with new model/mode, same session: ${r.sessionId === state.session_id ? 'PASS' : 'FAIL (' + r.sessionId + ')'}`);
  log(`(d1) AskUserQuestion reached canUseTool and parked: ${state.questions ? 'PASS' : 'FAIL'}`);
}

if (cmd === 'resume-answer') {
  if (!state.session_id) throw new Error('run plan first');
  const r = await run('resume-answer (answer + allowedTools pre-approval; unknown Bash must park)', query({
    prompt: `Answer to your question: "long". Now do exactly two things via Bash, one at a time: (1) run \`echo spike-ok\`; (2) run \`uname -a\`. Then call planestro report_done with a one-line summary and end your turn.`,
    options: {
      cwd: CWD, model: IMPLEMENTER, permissionMode: 'acceptEdits', resume: state.session_id,
      mcpServers: { planestro: planestroServer },
      allowedTools: ['mcp__planestro__report_done', 'Bash(echo spike-ok)'],
      canUseTool: canUseToolLogger((t, input) => t === 'Bash' ? { behavior: 'deny', message: 'Permission requires user approval; the request has been recorded by planestro — end this turn.' } : null),
    },
  }));
  log(`\n(d2) resumed with the answer: ${r.sessionId === state.session_id ? 'PASS' : 'FAIL'}`);
  log(`(e) allowedTools rule pre-approved echo (no canUseTool for it) and uname parked via canUseTool: inspect log above`);
}

if (cmd === 'kill') {
  const q = query({
    prompt: 'Run `sleep 25 && echo slept` via Bash, then tell me it finished.',
    options: { cwd: CWD, model: IMPLEMENTER, permissionMode: 'acceptEdits', allowedTools: ['Bash(sleep 25 && echo slept)'] },
  });
  let sid: string | undefined;
  const t = setTimeout(() => {
    try {
      const agents = JSON.parse(execFileSync('claude', ['agents', '--json'], { encoding: 'utf8' }));
      const mine = agents.find((a: any) => a.sessionId === sid);
      log(`  (h) claude agents --json entry for our session: ${mine ? JSON.stringify(mine) : 'NOT FOUND'}`);
      if (mine?.pid) { log(`  killing pid ${mine.pid} with SIGTERM`); process.kill(mine.pid, 'SIGTERM'); }
      else log('  no pid to kill; will rely on process exit');
    } catch (e) { log(`  (h) claude agents failed: ${e}`); }
  }, 8000);
  try {
    for await (const m of q) { log('- ' + summarize(m)); if (m.type === 'system' && (m as any).subtype === 'init') sid = (m as any).session_id; }
  } catch (e) { log(`  query threw after kill: ${String(e).slice(0, 200)}`); }
  clearTimeout(t);
  state.killed_session = sid; save();
  log(`(f) session ${sid} recorded for resume-after-kill`);
}

if (cmd === 'resume-after-kill') {
  if (!state.killed_session) throw new Error('run kill first');
  const r = await run('resume-after-kill', query({
    prompt: 'What command were you running before we were interrupted? Answer in one line, no tools.',
    options: { cwd: CWD, model: IMPLEMENTER, permissionMode: 'acceptEdits', resume: state.killed_session },
  }));
  log(`\n(f) torn session resumable: ${r.sessionId === state.killed_session && r.subtype === 'success' ? 'PASS' : 'FAIL'}; mentions sleep: ${/sleep/i.test(r.text)}`);
}

if (cmd === 'sessions') {
  const enc = CWD.replace(/[^a-zA-Z0-9]/g, '-');
  const expected = join(process.env.HOME!, '.claude', 'projects', enc, `${state.session_id}.jsonl`);
  log(`expected transcript: ${expected} exists=${existsSync(expected)}`);
  const info = state.session_id ? await getSessionInfo(state.session_id, { dir: CWD } as any).catch((e) => `getSessionInfo threw: ${e}`) : 'no session';
  log(`getSessionInfo: ${JSON.stringify(info).slice(0, 400)}`);
  const list = await listSessions({ dir: CWD } as any).catch((e) => `listSessions threw: ${e}`);
  log(`listSessions(dir): ${Array.isArray(list) ? list.length + ' sessions; ours present=' + list.some((s: any) => s.sessionId === state.session_id) : list}`);
  log(`(g) ${existsSync(expected) ? 'PASS' : 'CHECK'}`);
}

if (cmd === 'budget') {
  const r1 = await run('budget maxTurns=1', query({ prompt: 'List the files in tools/ using Glob, then Read tools/run_checks.sh, then summarize.', options: { cwd: CWD, model: IMPLEMENTER, permissionMode: 'acceptEdits', maxTurns: 1 } }));
  const r2 = await run('budget maxBudgetUsd=0.001', query({ prompt: 'Read CLAUDE.md fully and summarize it in detail.', options: { cwd: CWD, model: IMPLEMENTER, permissionMode: 'acceptEdits', maxBudgetUsd: 0.001 } }));
  log(`\n(i) subtypes: maxTurns→${r1.subtype}, maxBudgetUsd→${r2.subtype}`);
}

if (cmd === 'resume-park') {
  // (e) re-test: `uname -a` is in Claude Code's built-in read-only set, so it never reaches canUseTool.
  // Use a command that is neither read-only nor allowlisted by the project: `node -e`.
  if (!state.session_id) throw new Error('run plan first');
  const r = await run('resume-park (non-read-only, non-allowlisted Bash must reach canUseTool and park)', query({
    prompt: 'One more thing: run `node -e "console.log(\'park-probe\')"` via Bash. If the tool is denied, do not retry or work around it — just end your turn.',
    options: {
      cwd: CWD, model: IMPLEMENTER, permissionMode: 'acceptEdits', resume: state.session_id,
      canUseTool: canUseToolLogger((t) => t === 'Bash' ? { behavior: 'deny', message: 'Permission requires user approval; the request has been recorded by planestro — end this turn.' } : null),
    },
  }));
  const reached = readFileSync(LOG, 'utf8').includes('[canUseTool] Bash {"command":"node -e');
  log(`\n(e) non-allowlisted Bash reached canUseTool and parked: ${reached ? 'PASS' : 'FAIL'}; probe ran anyway: ${/park-probe/.test(r.text) ? 'YES (BAD)' : 'no'}`);
}
