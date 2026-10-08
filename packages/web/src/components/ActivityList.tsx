import { activityFeed, type ActivityEntry } from '../activityFeed.ts';

/** The Activity log newest first, like entries told as one line that opens to show them (#314). */
export function ActivityList({ entries, limit, stamp = (at) => at.slice(0, 19).replace('T', ' ') }: { entries: readonly ActivityEntry[]; limit?: number; stamp?: (at: string) => string }) {
  return (
    <ul className="activity">
      {activityFeed(entries, limit).map((g, i) => (
        <li key={`${g.at}-${i}`}>
          <span className="at">{stamp(g.at)}</span><span className="muted">{g.actor}</span>
          {g.entries.length > 1
            ? <details className="activity-group"><summary>{g.text}</summary><ul>{g.entries.map((e, j) => <li key={j}><span className="at">{stamp(e.at)}</span> {e.text}</li>)}</ul></details>
            : <span>{g.text}</span>}
        </li>
      ))}
    </ul>
  );
}
