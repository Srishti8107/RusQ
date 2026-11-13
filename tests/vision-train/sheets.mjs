/**
 * Review helper for the training images.
 *
 *   node tests/vision-train/sheets.mjs            → data/vision-train/_sheets/<label>_<page>.jpg (48 numbered thumbs each)
 *   node tests/vision-train/sheets.mjs apply      → applies tests/vision-train/review.json to dataset.json
 *
 * Building the sheets also writes tests/vision-train/sheets-index.json (sheet → image ids, frozen),
 * so positions on a sheet stay valid even if more images are downloaded later.
 * review.json: { "rejected": { "<sheet>": [positions…] }, "relabel": { "<sheet>": { "<position>": "<new label>" } } }
 * Everything on a reviewed sheet that is not rejected or relabelled becomes "accepted".
 */
import sharp from 'sharp';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MANIFEST = 'tests/vision-train/dataset.json';
const REVIEW = 'tests/vision-train/review.json';
const INDEX = 'tests/vision-train/sheets-index.json';
const OUT = 'data/vision-train/_sheets';
const PER = 48;
const COLS = 8;
const CELL = 200;

const items = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const byLabel = {};
for (const it of items) (byLabel[it.label] ??= []).push(it);
const pages = [];
for (const [label, list] of Object.entries(byLabel)) {
  list.sort((a, b) => a.id.localeCompare(b.id));
  for (let p = 0; p * PER < list.length; p++) pages.push({ key: `${label.replace(/ /g, '_')}_${p}`, label, list: list.slice(p * PER, (p + 1) * PER) });
}

if (process.argv[2] === 'apply') {
  const review = existsSync(REVIEW) ? JSON.parse(readFileSync(REVIEW, 'utf8')) : { rejected: {}, relabel: {} };
  let acc = 0;
  let rej = 0;
  let rel = 0;
  const index = JSON.parse(readFileSync(INDEX, 'utf8'));
  const byId = new Map(items.map((it) => [it.id, it]));
  for (const [key, ids] of Object.entries(index)) {
    if (!(key in (review.rejected ?? {})) && !(key in (review.relabel ?? {}))) continue; // sheet not reviewed yet
    const bad = new Set((review.rejected?.[key] ?? []).map(Number));
    const move = review.relabel?.[key] ?? {};
    ids.forEach((id, i) => {
      const it = byId.get(id);
      if (!it) return;
      if (bad.has(i)) {
        it.status = 'rejected';
        rej++;
      } else if (move[i]) {
        it.label = move[i];
        it.status = 'accepted';
        it.relabelled = true;
        rel++;
      } else {
        it.status = 'accepted';
        acc++;
      }
    });
  }
  writeFileSync(MANIFEST, JSON.stringify(items, null, 1));
  console.log({ accepted: acc, rejected: rej, relabelled: rel, unreviewed: items.filter((x) => x.status === 'unreviewed').length });
} else {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(INDEX, JSON.stringify(Object.fromEntries(pages.map((pg) => [pg.key, pg.list.map((it) => it.id)]))));
  for (const pg of pages) {
    const rows = Math.ceil(pg.list.length / COLS);
    const tiles = [];
    for (const [i, it] of pg.list.entries()) {
      let img;
      try {
        img = await sharp(it.file).resize(CELL, CELL, { fit: 'cover' }).toBuffer();
      } catch {
        img = await sharp({ create: { width: CELL, height: CELL, channels: 3, background: '#f00' } }).png().toBuffer();
      }
      const tag = Buffer.from(
        `<svg width="${CELL}" height="${CELL}"><rect x="0" y="0" width="${it.kind === 'video-frame' ? 64 : 40}" height="28" fill="black"/><text x="5" y="21" font-size="20" font-family="Arial" fill="yellow">${i}${it.kind === 'video-frame' ? 'v' : ''}</text></svg>`,
      );
      tiles.push({ input: await sharp(img).composite([{ input: tag }]).toBuffer(), left: (i % COLS) * CELL, top: Math.floor(i / COLS) * CELL });
    }
    await sharp({ create: { width: COLS * CELL, height: rows * CELL, channels: 3, background: '#fff' } })
      .composite(tiles)
      .jpeg({ quality: 72 })
      .toFile(join(OUT, `${pg.key}.jpg`));
    console.log(pg.key, pg.list.length);
  }
}
