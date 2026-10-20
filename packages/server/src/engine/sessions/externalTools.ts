import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { operatorMcpUrl } from '../../routes/mcp.ts';
import { listInstances } from '../../instances.ts';
import type { TurnOptions, CustomToolDef } from '../ports.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const EXT: Record<string, string> = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf' };

/**
 * A tool result as the Codex worker reads it (#366): text as text, and media (images, audio, binary resources) saved to a
 * file with its path in its place, never a base64 string in the conversation. Files go under the system temp folder,
 * readable from the sandbox; the worker copies what it keeps into its worktree.
 */
export async function toolText(result: Record<string, unknown>, server: string, dir = join(tmpdir(), 'planestro-mcp', server)): Promise<string> {
  const parts: string[] = [];
  const save = async (base64: string, mime?: string) => {
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${randomUUID()}.${(mime && EXT[mime]) ?? 'bin'}`);
    await writeFile(file, Buffer.from(base64, 'base64'));
    return `[${mime ?? 'binary'} saved to ${file}; copy it into the worktree to keep it]`;
  };
  for (const c of Array.isArray(result.content) ? result.content as Record<string, any>[] : []) {
    if (c.type === 'text') parts.push(String(c.text ?? ''));
    else if ((c.type === 'image' || c.type === 'audio') && typeof c.data === 'string') parts.push(await save(c.data, c.mimeType));
    else if (c.type === 'resource' && c.resource) parts.push(typeof c.resource.text === 'string' ? c.resource.text : typeof c.resource.blob === 'string' ? await save(c.resource.blob, c.resource.mimeType) : String(c.resource.uri ?? ''));
    else if (c.type === 'resource_link') parts.push(`[${c.name ?? 'resource'}: ${c.uri}]`);
    else parts.push(JSON.stringify(c));
  }
  if (!parts.length && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  // The protocol's older shape (2024-10-07) carried the whole result as `toolResult`.
  if (!parts.length && result.toolResult !== undefined) parts.push(JSON.stringify(result.toolResult));
  return parts.join('\n') || '(no content)';
}

/** The name a Codex thread is offered for an MCP tool: `<server>__<tool>`, never `mcp`/`mcp__…` (reserved), unique, ≤128 of [A-Za-z0-9_-]. */
export function dynamicName(server: string, tool: string, taken: readonly { name: string }[]): string {
  let base = `${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, '_');
  if (base === 'mcp' || base.startsWith('mcp__')) base = `ext_${base}`;
  base = base.slice(0, 120);
  let name = base;
  for (let n = 2; taken.some((t) => t.name === name); n++) name = `${base}_${n}`;
  return name;
}

/** Parent-owned clients; credentials are never copied to the Codex process. */
export async function externalTools(o: TurnOptions, onPark: () => void = () => {}): Promise<{ tools: CustomToolDef[]; close(): Promise<void> }> {
  const clients: Client[] = [];
  const tools: CustomToolDef[] = [];
  const close = async () => { await Promise.allSettled(clients.map((c) => c.close())); };
  try {
    // Planners are read-only. External services have no declared read-only capability yet.
    if (o.phase === 'plan' && Object.keys(o.mcpServers ?? {}).length) throw new Error('External MCP tools are not available to read-only planners');
    for (const [name, spec] of Object.entries(o.mcpServers ?? {})) {
      if (!/^[a-zA-Z0-9_-]+$/.test(name) || name.toLowerCase() === 'planestro') throw new Error('Invalid external MCP server name');
      if (spec.type === 'http' && operatorMcpUrl(spec.url, listInstances({ prune: false }).live, o.operatorHosts)) throw new Error('The operator MCP endpoint is never a worker tool');
      const client = new Client({ name: 'planestro-worker-bridge', version: '1' });
      clients.push(client);
      await client.connect(spec.type === 'http'
        ? new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: { headers: spec.headers } })
        : new StdioClientTransport({ command: spec.command, args: spec.args, env: spec.env }));
      let cursor: string | undefined;
      do {
        const page = await client.listTools({ cursor });
        for (const tool of page.tools) {
          // planestro's name for the call (permissions, the call cap, plans) is the MCP one; Codex reserves `mcp` and
          // `mcp__…` for its own servers and refuses a thread that offers them (#366, HH-538 on 0.162), so the
          // thread is offered `<server>__<tool>`, held to the Responses API's identifier rules.
          const fullName = `mcp__${name}__${tool.name}`;
          const offered = dynamicName(name, tool.name, tools);
          tools.push({ name: offered, description: `${tool.description ?? tool.name} (MCP server ${name}, tool ${tool.name})`, schema: {}, inputSchema: tool.inputSchema,
            handler: async (args) => {
              const decision = await o.onPermission({ tool: fullName, input: args });
              if (decision.action === 'park') onPark();
              if (decision.action !== 'allow') return decision.action === 'deny' ? decision.message : 'Recorded by planestro — end this turn';
              const result = await client.callTool({ name: tool.name, arguments: args });
              const text = await toolText(result, name);
              // A failed call is the tool's failure, not a success carrying an error message (#366).
              if (result.isError) throw new Error(`${name} reported an error: ${text}`);
              return text;
            } });
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
    return { tools, close };
  } catch (e) { await close(); throw e; }
}
