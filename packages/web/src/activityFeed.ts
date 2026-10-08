/** One Activity entry as the item view carries it. */
export interface ActivityEntry { at: string; actor: string; text: string }
/** A line of the feed: one entry, or a run of like entries told as one ("attached 5 images"), newest entry first inside. */
export interface ActivityGroup { at: string; actor: string; text: string; entries: ActivityEntry[] }

const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;
/** "attached attachments/x.png" groups with its neighbours by its verb: one word, then one file name. */
const shapeOf = (e: ActivityEntry) => /^(\S+) (\S+\.\w{1,8})$/.exec(e.text.trim());

/**
 * The Activity log newest first (#314), the board's quick view and the item page alike, with consecutive entries by the
 * same actor that only name a different thing (five "attached …png" in a row) told as one line. `limit` counts lines.
 */
export function activityFeed(entries: readonly ActivityEntry[], limit?: number): ActivityGroup[] {
  const out: ActivityGroup[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const last = out[out.length - 1];
    const verb = shapeOf(e)?.[1];
    if (last && verb && last.actor === e.actor && shapeOf(last.entries[0])?.[1] === verb) { last.entries.push(e); continue; }
    if (limit !== undefined && out.length >= limit) break;
    out.push({ at: e.at, actor: e.actor, text: e.text, entries: [e] });
  }
  for (const g of out) {
    if (g.entries.length < 2) continue;
    const verb = shapeOf(g.entries[0])![1];
    g.text = `${verb} ${g.entries.length} ${g.entries.every((e) => IMAGE.test(shapeOf(e)![2])) ? 'images' : 'files'}`;
  }
  return out;
}
