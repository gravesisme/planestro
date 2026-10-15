import { heldReasonOf, waitKindOf, type WaitKind } from '@planestro/shared';
import { api, type ItemView } from '../api.ts';
import { act } from '../store.ts';
import { land, waitTarget } from '../deepLink.ts';
import { ActionButton } from './ActionButton.tsx';

/** What each wait asks of you, as the header's shortcut names it. */
export const WAIT_LABEL: Record<WaitKind, string> = {
  plan: 'plan approval', breakdown: 'breakdown approval', permission: 'permission request', question: 'what the agent asked',
  audition: 'takes to pick', review: 'your review', decision: 'your decision', blocked: 'why it is blocked', hold: 'the hold',
};

/** Releasing a hold asks first; the note lands in the Activity log. The hold panel and the header shortcut both use it. */
export function promptReleaseHold(id: string): Promise<unknown> | undefined {
  const n = prompt(`Let ${id} merge? Optional note for the log:`);
  if (n !== null) return act(() => api.releaseHold(id, n || undefined));
}

/**
 * The item page's header shortcut to what the item waits on you for (#373): the panel that answers it can sit below a
 * long file list, so the header names it. A held pull request is released from here (one click, no form); every other
 * wait is a jump to its panel (`data-wait`, #226), which stays where it is and explains itself.
 */
export function WaitShortcut({ item }: { item: ItemView }) {
  const kind = item.derived.needs_you ? waitKindOf(item.frontmatter) : undefined;
  if (!kind) return null;
  if (kind === 'hold') {
    const held = heldReasonOf(item.frontmatter);
    return <>
      <ActionButton className="primary wait-shortcut" title="Lets its pull request merge: it goes back through sync and CI first" working="Releasing…" onAct={() => promptReleaseHold(item.id)}>Release hold</ActionButton>
      {held && <span className="small wait-reason"><b>Held:</b> {held}</span>}
    </>;
  }
  const jump = () => { const el = waitTarget(document, `#${kind}`, true); if (el) land(el); };
  return <button className="primary wait-shortcut" onClick={jump}>Jump to: {WAIT_LABEL[kind]}</button>;
}
