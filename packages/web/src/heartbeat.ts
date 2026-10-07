/**
 * Client activity (#224): on input, this tab tells the server someone is here, at most once a minute. The server holds
 * back a "needs you" notification while any tab has been used within notifications.idle_after_min, so a wait answered
 * at the desk never reaches the phone.
 */
export const HEARTBEAT_MS = 60_000;
const INPUT = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

/** A sender that sends at most once per HEARTBEAT_MS; `send` returns false when nothing could take it (no open socket). */
export function throttledBeat(send: () => boolean, now: () => number = Date.now): () => void {
  let last = -Infinity;
  return () => { const t = now(); if (t - last < HEARTBEAT_MS) return; if (send()) last = t; };
}

/** Send heartbeats over whatever socket `socket()` returns now, on the window's input events. */
export function watchInput(socket: () => WebSocket | undefined, target: Pick<Window, 'addEventListener'> = window): void {
  const beat = throttledBeat(() => {
    const ws = socket();
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ type: 'client.active' }));
    return true;
  });
  for (const type of INPUT) target.addEventListener(type, beat, { passive: true, capture: true });
}
