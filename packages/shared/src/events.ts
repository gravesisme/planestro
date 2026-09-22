/** WebSocket events pushed to the UI. Extended by later phases. */
export type ServerEvent =
  | { type: 'item.created'; id: string }
  | { type: 'item.updated'; id: string; source?: 'app' | 'external' }
  | { type: 'item.deleted'; id: string }
  | { type: 'prompt.updated'; name: string }
  | { type: 'release.updated'; version: string }
  | { type: 'config.updated' }
  | { type: 'journal.appended'; entry: JournalEntry }
  | { type: 'git.committed'; message: string }
  | { type: 'git.push_failed'; error: string }
  | { type: 'invalid_file'; path: string; error: string }
  | { type: 'index.reloaded' }
  | { type: 'engine.log'; level: 'info' | 'warn' | 'error'; message: string; item?: string }
  | { type: 'session.started'; id: string; session_id?: string }
  | { type: 'session.output'; id: string; text: string }
  | { type: 'session.ended'; id: string; subtype?: string }
  | { type: 'engine.paused'; paused: boolean };

export interface JournalEntry {
  ts: string;
  type: string;
  item?: string;
  actor: 'user' | 'app' | 'engine' | 'orchestrator' | 'worker' | string;
  data?: Record<string, unknown>;
}
