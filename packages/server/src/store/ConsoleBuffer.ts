import { isoLocal, type ServerEvent } from '@planestro/shared';

const MAX_LINES = 800;

/**
 * Per-item console: a ring buffer of session output and engine lines, fed from the same
 * event stream the WebSocket broadcasts, so the UI can show a live console for one item
 * and still seed it after a reload. In memory only — durable history lives in the
 * journal and the item's Activity.
 */
export class ConsoleBuffer {
  private buffers = new Map<string, string[]>();

  handle(e: ServerEvent): void {
    if (e.type === 'session.started') this.push(e.id, `── session ${e.session_id ? e.session_id.slice(0, 8) + ' ' : ''}turn started ──`);
    else if (e.type === 'session.output') this.push(e.id, e.text);
    else if (e.type === 'session.ended') this.push(e.id, `── turn ended (${e.subtype ?? 'success'}) ──`);
    else if (e.type === 'engine.log' && e.item) this.push(e.item, `[engine] ${e.message}`);
  }

  private push(id: string, text: string): void {
    const arr = this.buffers.get(id) ?? [];
    const stamp = isoLocal().slice(11, 19);
    for (const line of text.split('\n')) if (line.trim()) arr.push(`${stamp}  ${line}`);
    if (arr.length > MAX_LINES) arr.splice(0, arr.length - MAX_LINES);
    this.buffers.set(id, arr);
  }

  get(id: string): string[] { return this.buffers.get(id) ?? []; }
}
