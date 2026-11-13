/**
 * Copies the MANUALLY REVIEWED candidates into tests/fixtures/vision/ and writes
 * LABELS.json (label + attribution + licence). The selection below was made by
 * looking at every candidate image; rejected ones (postcards, portraits,
 * satellite images, cartoons, ambiguous scenes) are not copied.
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'tests/fixtures/vision-candidates';
const OUT = 'tests/fixtures/vision';
const REVIEWED = {
  'flooded street': ['0babde3d', '1541cb89', '1c8a0587', '1e704aa2', '6dff9782', 'bebff7b1', 'd558d5ae', 'f73a58fd', '239faf78', 'c56b1a4e'],
  'collapsed building': ['0357dc55', '1c60cd7a', '35ee9495', '6d71ae76', '82728c41', 'f62608d8'],
  'blocked road': ['33f91d2e', '388777eb', '4dbb7907', '86915b52', 'cb005a37', 'cf1eb67a', 'd780febc', 'ee718efa'],
  'fire or smoke': ['2fb8d05d', '43646d9e', 'c96bc738', 'ea286be2', 'ef267237'],
  'landslide debris': ['1a8d3145', '77496b9f', 'c2c5631a', 'f1b203c8'],
  'damaged bridge': ['08aa0881', '140c809f', '4f3e7273', '7cf2b74c', '9074a3b1', 'ad53cc02'],
  'people waiting for rescue': ['237b892a', '23be7770', 'cd479e8a', 'e8c69e17'],
  'normal street': ['42385479', '44435742', '65811c71', '9aa0d107', 'a331333c', 'c92c44b2', 'dbf71edd', '56298ca6', 'ddf3a50b'],
};

const cands = JSON.parse(readFileSync(join(SRC, 'candidates.json'), 'utf8'));
const files = new Map();
for (const dir of readdirSync(SRC).filter((d) => !d.startsWith('_') && !d.endsWith('.json'))) {
  for (const f of readdirSync(join(SRC, dir))) files.set(f.slice(0, 8), join(SRC, dir, f));
}
mkdirSync(OUT, { recursive: true });
const labels = [];
for (const [label, ids] of Object.entries(REVIEWED)) {
  for (const short of ids) {
    const src = files.get(short);
    if (!src) throw new Error(`missing ${short}`);
    const meta = cands.find((c) => c.id.startsWith(short));
    const name = `${label.replace(/ /g, '_')}__${short}.jpg`;
    copyFileSync(src, join(OUT, name));
    labels.push({ file: name, label, title: meta?.title, creator: meta?.creator, license: meta?.license, license_url: meta?.license_url, source: meta?.source });
  }
}
writeFileSync(join(OUT, 'LABELS.json'), JSON.stringify(labels, null, 2));
console.log('fixtures:', labels.length, Object.fromEntries(Object.entries(REVIEWED).map(([k, v]) => [k, v.length])));
