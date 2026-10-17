import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { loadsHere } from '../imageSource.ts';

const rewrite = (src?: string) => (src && src.startsWith('attachments/') ? `/${src}` : src);
/** Renders item markdown; managed attachment links (attachments/HH-1/x.png) resolve to the server route. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
        img: (p) => {
          const src = rewrite(p.src as string);
          return loadsHere(src) ? <img {...p} src={src} /> : <a href={src} target="_blank" rel="noreferrer">{p.alt || src}</a>;
        },
        a: (p) => <a {...p} href={rewrite(p.href as string)} target="_blank" rel="noreferrer" />,
      }}>
        {text || '_(empty)_'}
      </ReactMarkdown>
    </div>
  );
}
