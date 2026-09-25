/**
 * The browser tab says when this planestro needs you, so a background tab (another project's
 * planestro, say) is told apart at a glance: "(2) Board · Lake Monomonac" and a dot on the icon,
 * amber while items wait on you, red when one of them is blocked. Pages set their own title with
 * `setTitle`; the count is put in front of whatever they set.
 */
let base = 'planestro';
let needs = 0;
let hot = false;
let plainIcon: string | undefined;
let lastIcon = '';

function iconLink(): HTMLLinkElement | null { return document.querySelector<HTMLLinkElement>('link[rel="icon"]'); }

async function badgedIcon(color: string): Promise<string | undefined> {
  plainIcon ??= await fetch('/favicon.svg').then((r) => (r.ok ? r.text() : '')).catch(() => '');
  if (!plainIcon) return undefined;
  const dot = `<circle cx="22" cy="10" r="8.5" fill="${color}" stroke="#fff" stroke-width="2.5"/>`;
  return `data:image/svg+xml,${encodeURIComponent(plainIcon.replace('</svg>', `${dot}</svg>`))}`;
}

function apply(): void {
  document.title = needs > 0 ? `(${needs}) ${base}` : base;
  const want = needs > 0 ? (hot ? 'hot' : 'wait') : 'plain';
  if (want === lastIcon) return;
  lastIcon = want;
  if (want === 'plain') { const link = iconLink(); if (link) link.href = '/favicon.svg'; return; }
  void badgedIcon(want === 'hot' ? '#ff5d5d' : '#f0b64a').then((href) => {
    const link = iconLink();
    if (href && link && lastIcon === want) link.href = href;
  });
}

export function setTitle(title: string): void { base = title; apply(); }

export function setNeeds(count: number, blocked: boolean): void {
  if (count === needs && blocked === hot) return;
  needs = count; hot = blocked; apply();
}
