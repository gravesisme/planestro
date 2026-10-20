import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ReviewGallery } from '../../src/components/ReviewImages.tsx';
import { useStore } from '../../src/store.ts';
import { item, state } from './fixture.tsx';

const att = (name: string) => ({ path: `attachments/TP-1/${name}`, kind: 'managed', added_at: '2026-10-20T10:00:00Z' });

describe('the review gallery (#355, #372, #406)', () => {
  it('puts a flagged picture first with its pair, and a click zooms it until the next click', () => {
    const held = item('TP-1', {
      status: 'IN_REVIEW', skip_merge: true, hold_waits_on: 'person', hold_reason: 'art review',
      attachments: [att('lamp_before.png'), att('lamp_after.png'), att('sky.png')],
      review_handoff: { at: '2026-10-20T10:00:00Z', attached: [], flags: [{ path: 'attachments/TP-1/lamp_after.png', reason: 'halo on the left edge', severity: 'problem' }] },
    });
    useStore.setState({ state: state([held]) });
    const { container } = render(<ReviewGallery item={held} />);

    const look = container.querySelector('.needs-look') as HTMLElement;
    expect([...look.querySelectorAll('img')].map((i) => i.getAttribute('alt')?.split('/').pop())).toEqual(['lamp_before.png', 'lamp_after.png']);
    expect(within(look).getByText(/halo on the left edge/)).toBeTruthy();
    expect(look.querySelector('figure.flagged.sev-problem img')?.getAttribute('src')).toBe('/attachments/TP-1/lamp_after.png');

    fireEvent.click(screen.getByAltText('attachments/TP-1/sky.png'));
    const zoom = container.querySelector('.dialog') as HTMLElement;
    expect(zoom.querySelector('img')?.getAttribute('src')).toBe('/attachments/TP-1/sky.png');
    fireEvent.click(zoom);
    expect(container.querySelector('.dialog')).toBeNull();
  });
});
