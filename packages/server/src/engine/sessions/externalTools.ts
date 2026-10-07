import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { operatorMcpUrl } from '../../routes/mcp.ts';
import { listInstances } from '../../instances.ts';
import type { McpServerSpec, TurnOptions, CustomToolDef } from '../ports.ts';

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
          const fullName = `mcp__${name}__${tool.name}`;
          tools.push({ name: fullName, description: tool.description ?? tool.name, schema: {}, inputSchema: tool.inputSchema,
            handler: async (args) => {
              const decision = await o.onPermission({ tool: fullName, input: args });
              if (decision.action === 'park') onPark();
              if (decision.action !== 'allow') return decision.action === 'deny' ? decision.message : 'Recorded by planestro — end this turn';
              const result = await client.callTool({ name: tool.name, arguments: args });
              return JSON.stringify(result);
            } });
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
    return { tools, close };
  } catch (e) { await close(); throw e; }
}
