/**
 * Fetches CANDIDATE fixture images for the vision evaluation from Openverse,
 * restricted to CC0 / Public Domain Mark. Candidates are NOT ground truth:
 * every image is reviewed by eye and only correctly-labelled ones are copied
 * into tests/fixtures/vision/ (see tests/fixtures/vision/LABELS.json).
 *
 *   node scripts/fetch-vision-candidates.mjs
 */
import sharp from 'sharp';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'tests/fixtures/vision-candidates';
const QUERIES = process.argv[2] ? JSON.parse(process.argv[2]) : {
  'flooded street': ['flooded street', 'flood water street houses'],
  'collapsed building': ['collapsed building earthquake', 'earthquake rubble building'],
  'blocked road': ['fallen tree blocking road', 'road blocked debris storm'],
  'fire or smoke': ['house fire smoke', 'wildfire smoke'],
  'landslide debris': ['landslide', 'mudslide debris'],
  'damaged bridge': ['damaged bridge flood', 'collapsed bridge'],
  'people waiting for rescue': ['flood evacuees waiting', 'flood rescue boat people'],
  'normal street': ['city street', 'residential street houses'],
};
const PER_QUERY = 5;

const manifest = [];
for (const [label, queries] of Object.entries(QUERIES)) {
  const dir = join(OUT, label.replace(/ /g, '_'));
  mkdirSync(dir, { recursive: true });
  for (const q of queries) {
    const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&license=cc0,pdm&page_size=${PER_QUERY + 3}&mature=false`;
    const res = await fetch(url, { headers: { 'user-agent': 'rusq-fixture-fetcher/0.1' } });
    if (!res.ok) {
      console.log('query failed', q, res.status);
      continue;
    }
    const { results } = await res.json();
    let n = 0;
    for (const r of results) {
      if (n >= PER_QUERY) break;
      const file = join(dir, `${r.id}.jpg`);
      if (existsSync(file)) {
        n++;
        continue;
      }
      try {
        const img = await fetch(r.url, { headers: { 'user-agent': 'rusq-fixture-fetcher/0.1' }, signal: AbortSignal.timeout(20000) });
        if (!img.ok) continue;
        const buf = Buffer.from(await img.arrayBuffer());
        await sharp(buf).rotate().resize(800, 800, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toFile(file);
        manifest.push({ label, query: q, id: r.id, file, title: r.title, creator: r.creator, license: r.license, license_url: r.license_url, source: r.foreign_landing_url });
        n++;
      } catch (e) {
        console.log('skip', r.id, e.message);
      }
    }
    console.log(label, '|', q, '→', n);
  }
}
const prevPath = join(OUT, 'candidates.json');
const prev = existsSync(prevPath) ? JSON.parse((await import('node:fs')).readFileSync(prevPath, 'utf8')) : [];
writeFileSync(prevPath, JSON.stringify([...prev, ...manifest], null, 2));
console.log('total', manifest.length);
