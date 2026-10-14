import { categoryColor, contrastText } from '@planestro/shared';
import { useStore } from '../store.ts';

/** A category as a tag in its own color, with text picked to contrast with that color. */
export function CategoryTag({ name, color }: { name: string; color?: string }) {
  const config = useStore((s) => s.state?.config);
  const background = color ?? (config ? categoryColor(config, name) : undefined);
  if (!background) return <span className="tag">{name}</span>;
  return <span className="tag cat" style={{ background, color: contrastText(background), borderColor: background }}>{name}</span>;
}
