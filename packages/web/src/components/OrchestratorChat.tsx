import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { CHAT_ACCEPT, CHAT_MAX_FILES, chatAttachmentRefusal, type ChatAttachment, type JournalEntry } from '@planestro/shared';
import { api, type QuestionView } from '../api.ts';
import { act, useStore } from '../store.ts';
import { enterSends, growTo, isTouch, pickable } from '../chatInput.ts';
import { isImage, prepareUpload } from '../uploadImage.ts';

const SEEN_KEY = 'planestro.chat.seen';
const readSeen = () => { try { return localStorage.getItem(SEEN_KEY) ?? ''; } catch { return ''; } };
const writeSeen = (ts: string) => { try { localStorage.setItem(SEEN_KEY, ts); } catch { /* private window: the badge just shows again */ } };
const text = (e: JournalEntry) => String(e.data?.text ?? e.data?.question ?? e.data?.summary ?? '');
const attachmentsOf = (e: JournalEntry): ChatAttachment[] => (Array.isArray(e.data?.attachments) ? e.data.attachments as ChatAttachment[] : []);
const say = (error: string) => { useStore.setState({ error }); setTimeout(() => useStore.setState({ error: undefined }), 6000); };
/** A file waiting to go with the next message, and its thumbnail while it waits. */
type Pending = { file: File; url?: string };
const kb = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const Clip = () => <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20.5 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9" /></svg>;

/** What a message carried, in the thread (#288): images as thumbnails, files as chips; each opens the stored file. */
function Attachments({ list }: { list: ChatAttachment[] }) {
  if (!list.length) return null;
  return <div className="chat-atts">{list.map((a) => a.kind === 'image'
    ? <a key={a.path} href={`/${a.path}`} target="_blank" rel="noreferrer" title={a.name}><img src={`/${a.path}`} alt={a.name} loading="lazy" /></a>
    : <a key={a.path} className="chat-file doc" href={`/${a.path}`} target="_blank" rel="noreferrer" title={a.name}><span className="name">{a.name}</span><span className="muted">{kb(a.bytes)}</span></a>)}</div>;
}

/** A pause this long, or a new day, starts a new conversation in the thread: a divider marks it, and what is above the last one is dimmed. */
const GAP_MS = 2 * 60 * 60 * 1000;
const startsAnew = (prev: JournalEntry | undefined, e: JournalEntry) => prev !== undefined && (e.ts.slice(0, 10) !== prev.ts.slice(0, 10) || Date.parse(e.ts) - Date.parse(prev.ts) >= GAP_MS);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const when = (ts: string) => `${MONTHS[Number(ts.slice(5, 7)) - 1]} ${Number(ts.slice(8, 10))}, ${ts.slice(11, 16)}`;

/** What became of a question that is no longer open, said on its card so nobody answers it here by mistake. */
function settled(q: QuestionView): string {
  const why = q.frontmatter.resolution ? `: ${q.frontmatter.resolution}` : '';
  if (q.closed_by === 'planestro') return `never answered · no longer relevant${why}`;
  if (q.frontmatter.status === 'withdrawn') return `withdrawn · no longer relevant${why}`;
  return `answered${why}`;
}

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
  const questions = useStore((s) => s.questions);
  const { openChat, closeChat } = useStore.getState();
  const { pathname } = useLocation();
  const here = /^\/items\/([^/]+)/.exec(pathname)?.[1];
  const [msg, setMsg] = useState('');
  const [files, setFiles] = useState<Pending[]>([]);
  const [sending, setSending] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const maxBytes = useStore((s) => s.state?.config.attachments.managed_max_bytes) ?? 2_000_000;
  const touch = isTouch();
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
  // The input grows with the message (#288): measured at its natural height, capped at 40% of the panel or of what
  // is on screen above a phone's keyboard, whichever is less, so the thread keeps the rest.
  const grow = () => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    const room = Math.min(el.closest('.chat-panel')?.clientHeight ?? innerHeight, window.visualViewport?.height ?? innerHeight);
    const g = growTo(el.scrollHeight + el.offsetHeight - el.clientHeight, room);
    el.style.height = `${g.height}px`;
    el.style.overflowY = g.scroll ? 'auto' : 'hidden';
  };
  useLayoutEffect(grow, [msg, chat.open]);
  useEffect(() => { const vv = window.visualViewport ?? window; vv.addEventListener('resize', grow); return () => vv.removeEventListener('resize', grow); }, []);
  useEffect(() => { if (!chat.open) return; const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') closeChat(); }; addEventListener('keydown', esc); return () => removeEventListener('keydown', esc); }, [chat.open]);

  const unread = !chat.open && lastIn !== undefined && lastIn.ts > seen && lastIn.type !== 'orchestrator.done';
  const lastMine = [...entries].reverse().find((e) => e.type === 'orchestrator.user_message');
  const lastDone = [...entries].reverse().find((e) => e.type === 'orchestrator.done');
  const thinking = lastMine !== undefined && (!lastDone || lastDone.ts < lastMine.ts);
  const paused = state?.engine.paused ?? false;
  const ids = new Set(state?.items.map((i) => i.id) ?? []);
  const blocked = state?.items.filter((i) => i.frontmatter.blocked && i.derived.lane === 'board') ?? [];

  const attach = (list: File[]) => {
    const { take, skipped } = pickable(list);
    if (skipped.length) say(`${skipped.join(', ')}: not a type the chat takes (images, text, markdown, JSON, CSV, YAML, logs and PDFs)`);
    const room = CHAT_MAX_FILES - files.length;
    if (take.length > room) say(`at most ${CHAT_MAX_FILES} attachments in one message`);
    const added = take.slice(0, Math.max(0, room)).map((file) => ({ file, url: isImage(file) ? URL.createObjectURL(file) : undefined }));
    if (added.length) setFiles((f) => [...f, ...added]);
  };
  const unattach = (p: Pending) => { if (p.url) URL.revokeObjectURL(p.url); setFiles((f) => f.filter((x) => x !== p)); };

  const send = async (t = msg, withFiles = files) => {
    const body = t.trim();
    if ((!body && !withFiles.length) || sending) return;
    setSending(true);
    try {
      // Photos are converted and shrunk as on an item (HEIC → JPEG, within the size limit) before anything is cleared.
      let ready: File[];
      try { ready = await Promise.all(withFiles.map((p) => (isImage(p.file) ? prepareUpload(p.file, maxBytes) : p.file))); }
      catch (e) { say((e as Error).message); return; }
      const why = chatAttachmentRefusal(ready.map((f) => ({ name: f.name, size: f.size })), maxBytes);
      if (why) { say(why); return; }
      const typed = t === msg, pending = withFiles === files;
      if (typed) setMsg('');
      if (pending) setFiles([]);
      if (await act(() => api.orchestratorMessage(body, about, ready))) { for (const p of withFiles) if (p.url) URL.revokeObjectURL(p.url); return; }
      // Not sent: what was in the box comes back, unless something new was typed or attached meanwhile.
      if (typed) setMsg((m) => m || t);
      if (pending) setFiles((f) => (f.length ? f : withFiles));
    } finally { setSending(false); }
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
  const anew = rows.map((e, i) => startsAnew(rows[i - 1], e));
  const current = anew.lastIndexOf(true);
  const byId = new Map((questions ?? []).map((q) => [q.id, q]));
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
        {rows.map((e, i) => {
          const q = e.type === 'orchestrator.question' && typeof e.data?.id === 'string' ? byId.get(e.data.id) : undefined;
          const closed = q && q.frontmatter.status !== 'open' ? settled(q) : undefined;
          return <Fragment key={`${e.ts}-${i}`}>
          {anew[i] && <div className={`chat-divider ${i === current ? 'latest' : ''}`} role="separator"><span>{i === current ? `earlier conversation above · ${when(e.ts)}` : when(e.ts)}</span></div>}
          <div className={`chat-msg ${e.type.slice('orchestrator.'.length)}${i < current ? ' old' : ''}${closed ? ' settled' : ''}`}>
            {e.type === 'orchestrator.question' && <span className="small chat-label">{typeof e.data?.id === 'string' ? <Link to={`/questions/${e.data.id}`} title="Its page: the summary, the recommendation, and a discussion of its own">{closed ? 'question' : 'question for you'} ({e.data.id})</Link> : 'question for you'}{e.item ? <> · <Link to={`/items/${e.item}`}>{e.item}</Link></> : null}</span>}
            {closed && <span className="small chat-settled">{closed}</span>}
            {e.type === 'orchestrator.done' && <span className="small chat-label">finished without a reply</span>}
            {e.type === 'orchestrator.user_message' && e.item && <span className="small chat-label">about <Link to={`/items/${e.item}`}>{e.item}</Link></span>}
            {text(e) && <div className="chat-text"><Linked ids={ids}>{text(e)}</Linked></div>}
            <Attachments list={attachmentsOf(e)} />
            <span className="chat-at">{e.ts.slice(5, 16).replace('T', ' ')}</span>
          </div>
          </Fragment>;
        })}
        {thinking && !paused && <div className="chat-msg reply pending"><span className="muted">…</span></div>}
      </div>
      <div className="chat-suggest">
        <button className="chip" onClick={() => { setMsg('Add a backlog item: '); box.current?.focus(); }}>+ backlog item</button>
        {blocked.length > 0 && <button className="chip" onClick={() => void send(`Help me resolve the blocked item${blocked.length === 1 ? '' : 's'}: ${blocked.map((i) => `${i.id} (${i.frontmatter.blocked_reason ?? 'blocked'})`).join(', ')}. Tell me why each stopped, and unblock the ones you can fix with an instruction.`, [])}>help with {blocked.length} blocked</button>}
        {about && <button className="chip on" title="Your message is sent about this item; click to send it without one" onClick={() => setAbout(undefined)}>about {about} ×</button>}
        {!about && here && <button className="chip" onClick={() => setAbout(here)}>about {here}</button>}
      </div>
      <form className="chat-input" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        {files.length > 0 && <div className="chat-files">{files.map((p, i) => (
          <span key={`${p.file.name}-${i}`} className={`chat-file ${p.url ? 'thumb' : 'doc'}`} title={p.file.name}>
            {p.url ? <img src={p.url} alt={p.file.name} /> : <><span className="name">{p.file.name}</span><span className="muted">{kb(p.file.size)}</span></>}
            <button type="button" className="x" onClick={() => unattach(p)} aria-label={`Remove ${p.file.name}`} title="Remove">×</button>
          </span>))}</div>}
        <div className="chat-compose">
          <button type="button" className="chat-attach" onClick={() => picker.current?.click()} disabled={chat.enabled === false || files.length >= CHAT_MAX_FILES} aria-label="Attach images or files" title="Attach images or files (or paste an image)"><Clip /></button>
          <textarea ref={box} rows={1} value={msg} enterKeyHint={touch ? 'enter' : 'send'} placeholder="Message the orchestrator…" title={touch ? undefined : 'Enter to send, Shift+Enter for a new line; paste an image to attach it'} onChange={(e) => setMsg(e.target.value)}
            onKeyDown={(e) => { if (enterSends({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing }, touch)) { e.preventDefault(); void send(); } }}
            onPaste={(e) => { const pasted = [...e.clipboardData.files]; if (!pasted.length) return; if (!e.clipboardData.getData('text/plain')) e.preventDefault(); attach(pasted); }}
            disabled={chat.enabled === false} />
          <button className="primary" type="submit" disabled={(!msg.trim() && !files.length) || sending || chat.enabled === false}>{sending ? '…' : 'Send'}</button>
        </div>
        <input ref={picker} type="file" multiple accept={CHAT_ACCEPT} hidden onChange={(e) => { attach([...(e.target.files ?? [])]); e.target.value = ''; }} />
      </form>
    </div>
  );
}
