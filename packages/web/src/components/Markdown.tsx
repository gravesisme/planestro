import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Renders item markdown; managed attachment links (attachments/HH-1/x.png) resolve to the server route. */
export function Markdown({ text }: { text: string }) {
  const rewrite = (src?: string) => (src && src.startsWith('attachments/') ? `/${src}` : src);
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: (p) => <img {...p} src={rewrite(p.src as string)} />, a: (p) => <a {...p} href={rewrite(p.href as string)} target="_blank" rel="noreferrer" /> }}>
        {text || '_(empty)_'}
      </ReactMarkdown>
    </div>
  );
}
