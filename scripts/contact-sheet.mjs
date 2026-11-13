/** Builds numbered contact sheets of candidate images for manual label review. */
import sharp from 'sharp';
import { readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = process.argv[2] ?? 'tests/fixtures/vision-candidates';
const OUT = process.argv[3] ?? 'tests/fixtures/vision-candidates/_sheets';
mkdirSync(OUT, { recursive: true });
const CELL = 220;
for (const label of readdirSync(SRC).filter((d) => !d.startsWith('_') && !d.endsWith('.json'))) {
  const files = readdirSync(join(SRC, label)).filter((f) => f.endsWith('.jpg')).sort();
  const cols = 4;
  const rows = Math.ceil(files.length / cols);
  const tiles = await Promise.all(
    files.map(async (f, i) => {
      const img = await sharp(join(SRC, label, f)).resize(CELL, CELL, { fit: 'cover' }).toBuffer();
      const tag = Buffer.from(`<svg width="${CELL}" height="${CELL}"><rect x="0" y="0" width="44" height="30" fill="black"/><text x="6" y="22" font-size="22" font-family="Arial" fill="yellow">${i}</text></svg>`);
      return { input: await sharp(img).composite([{ input: tag }]).toBuffer(), left: (i % cols) * CELL, top: Math.floor(i / cols) * CELL };
    }),
  );
  await sharp({ create: { width: cols * CELL, height: rows * CELL, channels: 3, background: '#fff' } })
    .composite(tiles)
    .jpeg({ quality: 70 })
    .toFile(join(OUT, `${label}.jpg`));
  console.log(label, files.length, files.map((f, i) => `${i}:${f.slice(0, 8)}`).join(' '));
}
