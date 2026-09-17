import { deflateSync, crc32 } from 'node:zlib';

/**
 * A real PNG with no dependency, for the dry-run art agent: a soft two-tone tile with a lighter disc,
 * tinted from the seed so different items get different pictures. It exists so a dry run has actual
 * images to review — never as a stand-in for art a live agent failed to make.
 */
export function placeholderPng(seed: string, size = 96): Buffer {
  let h = 0; for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  const rgb = (l: number): [number, number, number] => { // hsl(hue, 55%, l) → rgb
    const s = 0.55, a = s * Math.min(l, 1 - l);
    const f = (n: number) => { const k = (n + hue / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
    return [f(0), f(8), f(4)];
  };
  const [dark, light] = [rgb(0.22), rgb(0.62)];
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const r = size / 2, corner = size * 0.2;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const dx = Math.max(corner - x, x - (size - 1 - corner), 0), dy = Math.max(corner - y, y - (size - 1 - corner), 0);
      const inside = dx * dx + dy * dy <= corner * corner;
      const disc = Math.hypot(x - r, y - r * 1.05) < size * 0.27;
      const c = disc ? light : dark;
      raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2]; raw[o + 3] = inside ? 255 : 0;
    }
  }
  const chunk = (type: string, data: Buffer) => { const body = Buffer.concat([Buffer.from(type, 'ascii'), data]); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0); return Buffer.concat([len, body, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Width and height from a PNG's header, or undefined for anything else. */
export function pngSize(buf: Buffer | null | undefined): { width: number; height: number } | undefined {
  if (!buf || buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString('ascii', 12, 16) !== 'IHDR') return undefined;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
