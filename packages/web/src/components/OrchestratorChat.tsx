import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import type { JournalEntry } from '@planestro/shared';
import { api } from '../api.ts';
import { act, useStore } from '../store.ts';

const SEEN_KEY = 'planestro.chat.seen';
const readSeen = () => { try { return localStorage.getItem(SEEN_KEY) ?? ''; } catch { return ''; } };
const writeSeen = (ts: string) => { try { localStorage.setItem(SEEN_KEY, ts); } catch { /* private window: the badge just shows again */ } };
const text = (e: JournalEntry) => String(e.data?.text ?? e.data?.question ?? e.data?.summary ?? '');

/** Item ids in a message become links, when the id is one of this project's items. */
function Linked({ children, ids }: { children: string; ids: Set<string> }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of children.matchAll(/\b[A-Z][A-Z0-9]*-\d+\b/g)) {
    if (!ids.has(m[0])) continue;
    parts.push(children.slice(last, m.index), <Link key={m.index} to={`/items/${m[0]}`}>{m[0]}</Link>);
    last = m.index! + m[0].length;
  }
  parts.push(children.slice(last));
  return <>{parts}</>;
}

/**
 * The way to talk to the orchestrator from anywhere: a floating button and a chat panel. A message
 * wakes it with the text and current state; it answers with reply_to_user, and in that wake it may
 * create items and unblock them for you. Its questions from other wakes show up here too.
 */
export function OrchestratorChat() {
  const chat = useStore((s) => s.chat);
  const state = useStore((s) => s.state);
  const { openChat, closeChat } = useStore.getState();
  const { pathname } = useLocation();
  const here = /^\/items\/([^/]+)/.exec(pathname)?.[1];
  const [msg, setMsg] = useState('');
  const [about, setAbout] = useState<string | undefined>();
  const [seen, setSeen] = useState(readSeen);
  const thread = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  // Load the thread once, quietly, so the button can say when something new is waiting.
  useEffect(() => { void useStore.getState().loadChat(); }, []);
  // Opening: take the draft and the item it was opened about (or the item on screen).
  useEffect(() => {
    if (!chat.open) return;
    setAbout(chat.item ?? here);
    if (chat.draft !== undefined) setMsg(chat.draft);
    setTimeout(() => box.current?.focus(), 0);
  }, [chat.open, chat.item, chat.draft]);
  const entries = chat.entries ?? [];
  const lastIn = [...entries].reverse().find((e) => e.type !== 'orchestrator.user_message');
  useEffect(() => { thread.current?.scrollTo({ top: thread.current.scrollHeight }); if (chat.open && lastIn && lastIn.ts > seen) { writeSeen(lastIn.ts); setSeen(lastIn.ts); } }, [chat.open, entries.length]);
  useEffect(() => { if (!chat.open) return; const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') closeChat(); }; addEventListener('keydown', esc); return () => removeEventListener('keydown', esc); }, [chat.open]);

  const unread = !chat.open && lastIn !== undefined && lastIn.ts > seen && lastIn.type !== 'orchestrator.done';
  const lastMine = [...entries].reverse().find((e) => e.type === 'orchestrator.user_message');
  const lastDone = [...entries].reverse().find((e) => e.type === 'orchestrator.done');
  const thinking = lastMine !== undefined && (!lastDone || lastDone.ts < lastMine.ts);
  const paused = state?.engine.paused ?? false;
  const ids = new Set(state?.items.map((i) => i.id) ?? []);
  const blocked = state?.items.filter((i) => i.frontmatter.blocked && i.derived.lane === 'board') ?? [];

  const send = async (t = msg) => {
    const body = t.trim();
    if (!body) return;
    setMsg('');
    await act(() => api.orchestratorMessage(body, about));
  };

  if (!chat.open) return (
    <button className={`chat-fab ${unread ? 'unread' : ''}`} onClick={() => openChat()} title="Talk to the orchestrator: add backlog items, get help with blocked ones" aria-label="Talk to the orchestrator">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" /><path d="M8 9.5h8M8 12.5h5" /></svg>
      <span className="desk-only">Orchestrator</span>
      {unread && <span className="badge" />}
    </button>
  );

  // Each wake that answered a message ends in a `done`; show its summary only when no reply said anything.
  let replied = false;
  const rows = entries.filter((e) => {
    if (e.type === 'orchestrator.user_message') replied = false;
    if (e.type === 'orchestrator.reply') replied = true;
    return e.type !== 'orchestrator.done' || !replied;
  });
  return (
    <div className="chat-panel" role="dialog" aria-label="Orchestrator chat">
      <div className="chat-head">
        <b>Orchestrator</b>
        <span className="muted small grow">{chat.enabled === false ? 'not available with this engine' : paused ? 'automation is paused: it answers when you resume' : thinking ? 'working on it…' : 'reads the backlog, adds items, helps with blocks'}</span>
        <button className="chip-x" onClick={closeChat} aria-label="Close" title="Close (Esc)">×</button>
      </div>
      <div className="chat-thread" ref={thread}>
        {!rows.length && <div className="muted small chat-empty">
          <p>Ask for what you want in plain words. It wakes with your message and the current state of the backlog, and answers here.</p>
          <p>It can add backlog items for you, explain why an item is blocked and unblock it with instructions for the worker, message a running session, and reorder the queue.</p>
        </div>}
        {rows.map((e, i) => (
          <div key={`${e.ts}-${i}`} className={`chat-msg ${e.type.slice('orchestrator.'.length)}`}>
            {e.type === 'orchestrator.question' && <span className="small chat-label">{typeof e.data?.id === 'string' ? <Link to={`/questions/${e.data.id}`} title="Its page: the summary, the recommendation, and a discussion of its own">question for you ({e.data.id})</Link> : 'question for you'}{e.item ? <> · <Link to={`/items/${e.item}`}>{e.item}</Link></> : null}</span>}
            {e.type === 'orchestrator.done' && <span className="small chat-label">finished without a reply</span>}
            {e.type === 'orchestrator.user_message' && e.item && <span className="small chat-label">about <Link to={`/items/${e.item}`}>{e.item}</Link></span>}
            <div className="chat-text"><Linked ids={ids}>{text(e)}</Linked></div>
            <span className="chat-at">{e.ts.slice(5, 16).replace('T', ' ')}</span>
          </div>
        ))}
        {thinking && !paused && <div className="chat-msg reply pending"><span className="muted">…</span></div>}
      </div>
      <div className="chat-suggest">
        <button className="chip" onClick={() => { setMsg('Add a backlog item: '); box.current?.focus(); }}>+ backlog item</button>
        {blocked.length > 0 && <button className="chip" onClick={() => void send(`Help me resolve the blocked item${blocked.length === 1 ? '' : 's'}: ${blocked.map((i) => `${i.id} (${i.frontmatter.blocked_reason ?? 'blocked'})`).join(', ')}. Tell me why each stopped, and unblock the ones you can fix with an instruction.`)}>help with {blocked.length} blocked</button>}
        {about && <button className="chip on" title="Your message is sent about this item; click to send it without one" onClick={() => setAbout(undefined)}>about {about} ×</button>}
        {!about && here && <button className="chip" onClick={() => setAbout(here)}>about {here}</button>}
      </div>
      <form className="chat-input" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <textarea ref={box} rows={2} value={msg} placeholder="Message the orchestrator… (Enter to send, Shift+Enter for a new line)" onChange={(e) => setMsg(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} disabled={chat.enabled === false} />
        <button className="primary" type="submit" disabled={!msg.trim() || chat.enabled === false}>Send</button>
      </form>
    </div>
  );
}
