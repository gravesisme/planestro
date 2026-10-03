/**
 * The session's lost connection to planestro, while the item still carries it (#167, HH-377): `op_data.mcp_drop`, set at the
 * first error of the turn and cleared by the next turn that runs without one.
 */
export function connectionDropOf(fm: { op_data?: Record<string, unknown> }): { error: string; at: string; tool?: string; finalMessage?: string } | undefined {
  const d = fm.op_data?.mcp_drop as { error?: unknown; at?: unknown; tool?: unknown; final_message?: unknown } | undefined;
  if (typeof d?.error !== 'string' || typeof d.at !== 'string') return undefined;
  return { error: d.error, at: d.at, ...(typeof d.tool === 'string' ? { tool: d.tool } : {}), ...(typeof d.final_message === 'string' && d.final_message ? { finalMessage: d.final_message } : {}) };
}
