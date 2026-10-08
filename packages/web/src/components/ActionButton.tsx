import { createContext, useContext, useId, type ButtonHTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import { useAction } from '../sending.ts';
import { showError } from '../store.ts';
import { Sending } from './Sending.tsx';

// ---- every action shows at once that it is working (#304) ----
// A button that makes something happen marks itself the moment it is pressed (a spinner and what it is doing), and is
// locked with its siblings in the same `ActionGroup` until the action ends: a second press sends nothing. An error
// unlocks it (and shows); a success unlocks once `act` has refreshed the view, which usually takes the button away.

const Group = createContext<ReturnType<typeof useAction> | undefined>(undefined);

/** The buttons inside lock together while one of them is working: one card's or one panel's actions. */
export function ActionGroup({ children }: { children: ReactNode }) {
  return <Group.Provider value={useAction()}>{children}</Group.Provider>;
}

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  /** What the press does: usually `act(() => api.…)`. A confirm or prompt that is cancelled just returns. */
  onAct: () => unknown;
  /** Shown in place of the label while it works, e.g. "Approving…". */
  working?: string;
};

export function ActionButton({ onAct, working = 'Working…', disabled, children, ...rest }: Props) {
  const own = useAction();
  const { busy, run } = useContext(Group) ?? own;
  const id = useId();
  const mine = busy === id;
  const press = (e: MouseEvent<HTMLButtonElement>) => {
    const form = rest.type === 'submit' ? e.currentTarget.form : null;
    if (form) { e.preventDefault(); if (!form.reportValidity()) return; }   // the action is the submit; the form only validates
    run(id, async () => { await onAct(); return true; }).catch(showError);
  };
  return <button {...rest} disabled={disabled || busy !== undefined} aria-busy={mine || undefined} onClick={press}>{mine ? <Sending label={working} /> : children}</button>;
}
