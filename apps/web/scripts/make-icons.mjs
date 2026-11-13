// Rasterises the SVG icons to the PNG sizes required for installability (Android + iOS).
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
const dir = new URL('../public/icons/', import.meta.url);
const jobs = [
  ['icon.svg', 'icon-192.png', 192], ['icon.svg', 'icon-512.png', 512], ['icon.svg', 'apple-touch-icon.png', 180],
  ['icon.svg', 'maskable-512.png', 512, 56],
  ['sos.svg', 'sos-192.png', 192], ['sos.svg', 'sos-512.png', 512], ['sos.svg', 'sos-apple-touch-icon.png', 180],
];
for (const [src, out, size, pad = 0] of jobs) {
  const svg = readFileSync(new URL(src, dir));
  const inner = size - pad * 2;
  let img = sharp(svg, { density: 300 }).resize(inner, inner);
  if (pad) img = img.extend({ top: pad, bottom: pad, left: pad, right: pad, background: src === 'sos.svg' ? '#7F0000' : '#0B4A22' });
  await img.png().toFile(new URL(out, dir).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  console.log('wrote', out);
}
