import { useRef, useState } from 'react';

// ---- one answer at a time (#282) ----
// An answer tapped on a phone showed nothing until the view updated, so it was tapped again. The guard is synchronous
// (React state is not, and two quick taps both got through): the first tap marks its answer at once, and every other
// tap is ignored while it is in flight. A sent answer keeps the card locked until it goes away; a failed one unlocks.

export function oneAtATime(onChange: (key: string | undefined) => void) {
  let current: string | undefined;
  const set = (k: string | undefined) => { current = k; onChange(k); };
  return {
    busy: () => current,
    /** `send` resolves truthy when the answer went through (`act` resolves undefined on an error it has shown). */
    async run(key: string, send: () => Promise<unknown>): Promise<boolean> {
      if (current !== undefined) return false;
      set(key);
      try {
        const ok = Boolean(await send());
        if (!ok) set(undefined);
        return ok;
      } catch (e) { set(undefined); throw e; }
    },
  };
}

/**
 * The guard for one card: `sending` names the answer in flight (or the one sent, while the card is still shown).
 * `waitKey` names what is being answered: a new request (or another item in the same panel) starts unlocked.
 */
export function useSending(waitKey: string) {
  const [state, setState] = useState<{ key: string; sending?: string }>({ key: waitKey });
  const guard = useRef<{ key: string; g: ReturnType<typeof oneAtATime> }>(undefined);
  if (guard.current?.key !== waitKey) guard.current = { key: waitKey, g: oneAtATime((sending) => setState({ key: waitKey, sending })) };
  return { sending: state.key === waitKey ? state.sending : undefined, send: guard.current.g.run };
}
