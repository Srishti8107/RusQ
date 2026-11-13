/**
 * Collects TRAINING images for the hazard classifier from Wikimedia Commons categories
 * (photos + still frames from videos – CCTV / phone-video-like). Free licences only; the
 * images stay out of git (data/vision-train/), only tests/vision-train/dataset.json
 * (source, licence, author, label, review status) is committed.
 *
 *   node tests/vision-train/fetch.mjs            # fetch / top up
 *
 * Category = candidate label, NOT ground truth: every image is reviewed by eye on contact
 * sheets (tests/vision-train/sheets.mjs) and wrong ones are marked "rejected".
 */
import sharp from 'sharp';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'data/vision-train';
const MANIFEST = 'tests/vision-train/dataset.json';
const UA = 'RusQ-vision-training/0.1 (disaster-response research prototype)';
const API = 'https://commons.wikimedia.org/w/api.php';

/** label → [category, max photos, max videos] ; subcategories are followed one level. */
const PLAN = {
  'flooded street': [
    ['Category:Floods in Nepal', 70, 10],
    ['Category:Floods of Bagmati River in Nepal', 40, 6],
    ['Category:Flood damage in Nepal', 30, 4],
    ['Category:2026 Nepal and Tibet floods', 30, 4],
    ['Category:2017 South Asian floods', 30, 4],
    ['Category:Floods in India', 40, 6],
    ['Category:Floods in Bangladesh', 30, 4],
    ['Category:Flooded streets', 50, 6],
    ['Category:Videos of floods', 0, 30],
    ['Category:Videos of floods in Vietnam', 0, 8],
  ],
  'fire or smoke': [
    ['Category:Building fires', 50, 6],
    ['Category:Burning buildings', 40, 4],
    ['Category:Fires in Nepal', 30, 4],
    ['Category:Fires in India', 30, 4],
    ['Category:Videos of fire', 0, 25],
  ],
  'normal street': [
    ['Category:Streets in Kathmandu', 60, 6],
    ['Category:Streets and squares in Kathmandu', 30, 2],
    ['Category:New Road, Kathmandu', 15, 2],
    ['Category:Rain in Nepal', 25, 4],
    ['Category:Monsoon in Nepal', 25, 4],
    ['Category:Wet roads', 30, 4],
    ['Category:Videos of traffic', 0, 12],
  ],
  'landslide debris': [
    ['Category:Landslides in Nepal', 50, 6],
    ['Category:Landslide damage in Nepal', 30, 4],
    ['Category:Landslides in Nepal in 2015', 20, 2],
    ['Category:Videos of landslides', 0, 10],
  ],
  'collapsed building': [
    ['Category:Damage from the April 2015 Nepal earthquake', 60, 6],
    ['Category:Collapsed buildings', 40, 4],
  ],
  'damaged bridge': [
    ['Category:Collapsed bridges', 50, 4],
    ['Category:Destroyed bridges', 30, 2],
  ],
  'blocked road': [
    ['Category:Fallen trees', 40, 4],
    ['Category:Fallen trees on roads', 30, 2],
  ],
  'people waiting for rescue': [
    ['Category:Flood rescue', 40, 6],
    ['Category:Flood evacuation', 30, 4],
    ['Category:Rescue personal watercraft', 20, 2],
  ],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastApi = 0;
async function api(params) {
  const url = `${API}?${new URLSearchParams({ format: 'json', formatversion: '2', maxlag: '5', ...params })}`;
  for (let i = 0; i < 6; i++) {
    const wait = 1100 - (Date.now() - lastApi); // ≤ 1 request per second
    if (wait > 0) await sleep(wait);
    lastApi = Date.now();
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30000) });
      const text = await r.text();
      if (r.ok && text.startsWith('{')) {
        const j = JSON.parse(text);
        if (!j.error) return j;
      }
    } catch {
      /* retry */
    }
    await sleep(15000 * (i + 1)); // rate-limited or failed: back off
  }
  throw new Error(`api failed ${url}`);
}

async function members(cat, type) {
  const out = [];
  let cont;
  do {
    const j = await api({ action: 'query', list: 'categorymembers', cmtitle: cat, cmtype: type, cmlimit: '200', ...(cont ? { cmcontinue: cont } : {}) });
    out.push(...(j.query?.categorymembers ?? []).map((m) => m.title));
    cont = j.continue?.cmcontinue;
  } while (cont && out.length < 600);
  return out;
}

async function filesOf(cat) {
  const direct = await members(cat, 'file');
  const subs = (await members(cat, 'subcat')).slice(0, 12);
  const nested = [];
  for (const s of subs) nested.push(...(await members(s, 'file')).slice(0, 40));
  return [...new Set([...direct, ...nested])];
}

async function info(titles, seek) {
  const j = await api({ action: 'query', titles: titles.join('|'), prop: 'imageinfo', iiprop: 'url|mime|size|extmetadata|metadata', iiurlwidth: '960', ...(seek !== undefined ? { iiurlparam: `seek=${seek}` } : {}) });
  return j.query?.pages ?? [];
}

const strip = (s) => String(s ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
const FREE = /^(cc0|public domain|pd|cc by|cc-by|cc by-sa|cc-by-sa|attribution|gfdl|fal)/i;

const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : [];
const have = new Set(manifest.map((m) => m.id));
let added = 0;

async function save(entry, url) {
  const dir = join(OUT, entry.label.replace(/ /g, '_'));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${entry.id}.jpg`);
  if (!existsSync(file)) {
    await sleep(400);
    let buf;
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(60000) });
      if (!r.ok) return false;
      buf = Buffer.from(await r.arrayBuffer());
    } catch {
      return false;
    }
    try {
      await sharp(buf).rotate().resize(800, 800, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(file);
    } catch {
      return false;
    }
  }
  manifest.push({ ...entry, file: file.replace(/\\/g, '/') });
  have.add(entry.id);
  added++;
  return true;
}

const usedTitles = new Set(manifest.map((m) => m.title));
for (const [label, cats] of Object.entries(PLAN)) {
  for (const [cat, maxPhotos, maxVideos] of cats) {
    let titles;
    try {
      titles = await filesOf(cat);
    } catch (e) {
      console.log('skip category', cat, e.message);
      continue;
    }
    let photos = 0;
    let videos = 0;
    for (let i = 0; i < titles.length && (photos < maxPhotos || videos < maxVideos); i += 25) {
      const batch = titles.slice(i, i + 25).filter((t) => !usedTitles.has(t));
      if (!batch.length) continue;
      for (const p of await info(batch)) {
        const ii = p.imageinfo?.[0];
        if (!ii) continue;
        const lic = strip(ii.extmetadata?.LicenseShortName?.value);
        if (!FREE.test(lic)) continue;
        const base = { label, category: cat, title: p.title, source: ii.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title)}`, license: lic, author: strip(ii.extmetadata?.Artist?.value), status: 'unreviewed' };
        if (/^image\/(jpeg|png|webp)$/.test(ii.mime) && photos < maxPhotos && ii.width >= 320) {
          if (await save({ ...base, id: `p${p.pageid}`, kind: 'photo', group: `p${p.pageid}` }, ii.thumburl ?? ii.url)) photos++;
          usedTitles.add(p.title);
        } else if (/^video\//.test(ii.mime) && videos < maxVideos) {
          const len = Number((ii.metadata ?? []).find((m) => m.name === 'playtime_seconds')?.value ?? 0);
          if (!(len > 2)) continue;
          const seeks = [0.15, 0.5, 0.85].map((f) => Math.max(1, Math.round(len * f)));
          let got = 0;
          for (const s of seeks) {
            const fid = `v${p.pageid}_${s}`;
            if (have.has(fid)) continue;
            const [fp] = await info([p.title], s);
            const tu = fp?.imageinfo?.[0]?.thumburl;
            if (tu && (await save({ ...base, id: fid, kind: 'video-frame', seconds: s, group: `v${p.pageid}` }, tu))) got++;
            await sleep(150);
          }
          if (got) videos++;
          usedTitles.add(p.title);
        }
      }
      await sleep(200);
    }
    console.log(`${label.padEnd(26)} ${cat} → ${photos} photos, ${videos} videos (of ${titles.length} files)`);
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
  }
}
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
console.log('added', added, 'total', manifest.length);
