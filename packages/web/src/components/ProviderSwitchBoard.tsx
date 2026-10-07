import type { ItemView } from '../api.ts';
import { ItemCard, statusLabel } from './ItemCard.tsx';

const ACTIVE_COLUMNS = ['QUEUED', 'PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS', 'IN_REVIEW'] as const;
type SelectionProps = { items: ItemView[]; selected: string[]; onChange: (ids: string[]) => void };

function StatusColumn({ status, items, selected, onChange }: SelectionProps & { status: string }) {
  const ids = items.map((item) => item.id);
  const count = ids.filter((id) => selected.includes(id)).length;
  const toggle = (checked: boolean, targets: string[]) => onChange(checked
    ? [...new Set([...selected, ...targets])]
    : selected.filter((id) => !targets.includes(id)));
  return <section className="column" aria-labelledby={`switch-${status}`}>
    <h3 id={`switch-${status}`}><label>
      <input type="checkbox" aria-label={`Select all ${statusLabel(status)} items`} disabled={!items.length}
        checked={items.length > 0 && count === items.length}
        ref={(node) => { if (node) node.indeterminate = count > 0 && count < items.length; }}
        onChange={(e) => toggle(e.target.checked, ids)} />
      {statusLabel(status)}
    </label><span>{items.length}</span></h3>
    <p className="provider-column-count">{count} selected</p>
    <div className="provider-status-cards">{items.map((item) => <ItemCard key={item.id} item={item} sortable={false}
      selection={{ checked: selected.includes(item.id), onChange: (checked) => toggle(checked, [item.id]) }} />)}</div>
    {!items.length && <p className="muted">No items</p>}
  </section>;
}

export function ProviderSwitchBoard({ items, selected, onChange }: SelectionProps) {
  const active = items.filter((item) => ACTIVE_COLUMNS.some((status) => status === item.frontmatter.status));
  const backlog = items.filter((item) => item.frontmatter.status === 'NOT_YET_SUBMITTED');
  return <>
    <div className="provider-selection-toolbar">
      <h2>Queued and underway <span className="muted">({active.length})</span></h2>
      <div className="row">
        <button type="button" disabled={!active.length} onClick={() => onChange(active.map((item) => item.id))}>Select only queued and underway</button>
        <button type="button" disabled={!selected.length} onClick={() => onChange([])}>Clear selection</button>
      </div>
    </div>
    <div className="board provider-switch-board">{ACTIVE_COLUMNS.map((status) => <StatusColumn key={status} status={status}
      items={active.filter((item) => item.frontmatter.status === status)} selected={selected} onChange={onChange} />)}</div>
    <details className="provider-backlog">
      <summary>Not yet submitted <span className="muted">({backlog.length}) · {backlog.filter((item) => selected.includes(item.id)).length} selected</span></summary>
      <p>These items stay on their current models unless you select them. Switching their provider does not queue them for planning.</p>
      <StatusColumn status="NOT_YET_SUBMITTED" items={backlog} selected={selected} onChange={onChange} />
    </details>
  </>;
}
