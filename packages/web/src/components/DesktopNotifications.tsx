import { useState } from 'react';
import { desktopSupported, desktopWanted, enableDesktop, setDesktopWanted } from '../desktopNotify.ts';

/** The Notifications tab's per-device switch (#70): merges and usage pauses as desktop notifications from this browser. */
export function DesktopNotifications() {
  const [on, setOn] = useState(() => desktopWanted() && desktopSupported() && Notification.permission === 'granted');
  const [said, setSaid] = useState('');
  if (!desktopSupported()) return <div className="desk-notify small" role="note">This browser cannot show desktop notifications.</div>;
  const toggle = async () => {
    if (on) { setDesktopWanted(false); setOn(false); setSaid(''); return; }
    const p = await enableDesktop();
    setOn(p === 'granted');
    setSaid(p === 'granted' ? '' : p === 'denied' ? 'The browser has blocked notifications for this site: allow them in its site settings, then try again.' : 'Not allowed yet.');
  };
  return (
    <div className="desk-notify" role="note">
      <b>Desktop notifications on this device</b>
      <p className="small">Merges and usage pauses, shown while a planestro tab is open. Installed as an app (in Chrome: ⋮ → Cast, save and share → Install planestro), they come under planestro's own name and icon.</p>
      <div className="row"><button className={on ? '' : 'primary'} onClick={() => void toggle()}>{on ? 'Turn off on this device' : 'Turn on'}</button>{said && <span className="small muted">{said}</span>}</div>
    </div>
  );
}
