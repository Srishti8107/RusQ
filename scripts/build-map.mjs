/**
 * Builds the OFFLINE SAMPLE-REGION MAP: one self-hosted PMTiles file of vector
 * tiles (§4 "PMTiles, self-hosted; do not bulk-download OpenStreetMap tiles").
 *
 * We do NOT download any rendered tiles. We take ONE small OpenStreetMap data
 * extract (roads, water, railways) for the sample region via the Overpass API,
 * cut it into Mapbox Vector Tiles ourselves (geojson-vt + vt-pbf) and pack them
 * into a PMTiles v3 archive (writer below, ~80 lines, spec:
 * https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md).
 *
 *   node scripts/build-map.mjs                 # fetch extract (cached) and build
 *   node scripts/build-map.mjs path/to/osm.json  # build from a saved extract
 *
 * Output: apps/web/public/map/region.pmtiles (+ region.json with bounds/attribution).
 * Data © OpenStreetMap contributors, ODbL 1.0.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(join(ROOT, 'apps/web/package.json'));
const geojsonvt = req('geojson-vt').default ?? req('geojson-vt');
const vtpbf = req('vt-pbf');
const { zxyToTileId } = await import(new URL('file:///' + req.resolve('pmtiles').replace(/\\/g, '/')).href);

/** Sample region: central Kathmandu (Kathmandu district, Nepal) – Bagmati flood scenario; every sample shelter is inside it. */
export const REGION = { name: 'Kathmandu sample region (Nepal)', south: 27.67, west: 85.28, north: 27.745, east: 85.37 };
const MIN_Z = 10;
const MAX_Z = 15;

const CACHE = join(ROOT, 'apps/web/.map-cache/osm-extract.json');
const OUT_DIR = join(ROOT, 'apps/web/public/map');

const MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

async function fetchExtract() {
  const b = `${REGION.south},${REGION.west},${REGION.north},${REGION.east}`;
  const q = `[out:json][timeout:120];(
    way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|motorway_link|trunk_link|primary_link|secondary_link)$"](${b});
    way["natural"="water"](${b}); relation["natural"="water"](${b});
    way["waterway"~"^(river|canal|stream|drain)$"](${b});
    way["railway"="rail"](${b}););out geom;`;
  for (const url of MIRRORS) {
    try {
      const r = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: q }), headers: { 'user-agent': 'rusq-map-builder/0.1' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      mkdirSync(dirname(CACHE), { recursive: true });
      writeFileSync(CACHE, JSON.stringify(json));
      console.log(`fetched extract from ${url}`);
      return json;
    } catch (e) {
      console.warn(`${url} failed: ${e.message}`);
    }
  }
  throw new Error('All Overpass mirrors failed – try again later, or pass a saved extract path.');
}

/* ------------------------- OSM → GeoJSON layers ------------------------- */

const ROAD_CLASS = {
  motorway: 'major', trunk: 'major', primary: 'major', motorway_link: 'major', trunk_link: 'major', primary_link: 'major',
  secondary: 'medium', tertiary: 'medium', secondary_link: 'medium',
  residential: 'minor', unclassified: 'minor',
};

const line = (geom) => geom.map((p) => [p.lon, p.lat]);
const closed = (c) => c.length > 3 && c[0][0] === c.at(-1)[0] && c[0][1] === c.at(-1)[1];

/** Join member ways of a multipolygon into closed rings (endpoint matching). */
function stitchRings(ways) {
  const open = ways.map((w) => w.slice());
  const rings = [];
  while (open.length) {
    let ring = open.pop();
    let guard = 0;
    while (!closed(ring) && guard++ < 10_000) {
      const end = ring.at(-1);
      const i = open.findIndex((w) => (w[0][0] === end[0] && w[0][1] === end[1]) || (w.at(-1)[0] === end[0] && w.at(-1)[1] === end[1]));
      if (i < 0) break;
      const next = open.splice(i, 1)[0];
      ring = ring.concat(next[0][0] === end[0] && next[0][1] === end[1] ? next.slice(1) : next.reverse().slice(1));
    }
    if (closed(ring)) rings.push(ring);
  }
  return rings;
}

function toLayers(osm) {
  const L = { water: [], waterway: [], roads: [], rail: [] };
  for (const el of osm.elements) {
    const t = el.tags ?? {};
    if (el.type === 'way' && el.geometry) {
      const c = line(el.geometry);
      if (t.highway && ROAD_CLASS[t.highway]) L.roads.push({ type: 'Feature', properties: { class: ROAD_CLASS[t.highway] }, geometry: { type: 'LineString', coordinates: c } });
      else if (t.natural === 'water' && closed(c)) L.water.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [c] } });
      else if (t.waterway) L.waterway.push({ type: 'Feature', properties: { class: t.waterway === 'river' || t.waterway === 'canal' ? 'large' : 'small' }, geometry: { type: 'LineString', coordinates: c } });
      else if (t.railway === 'rail') L.rail.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: c } });
    } else if (el.type === 'relation' && t.natural === 'water' && el.members) {
      const outer = stitchRings(el.members.filter((m) => m.type === 'way' && m.role !== 'inner' && m.geometry).map((m) => line(m.geometry)));
      const inner = stitchRings(el.members.filter((m) => m.type === 'way' && m.role === 'inner' && m.geometry).map((m) => line(m.geometry)));
      for (const o of outer) L.water.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [o, ...inner] } });
    }
  }
  return L;
}

/* ------------------------------ tiling ------------------------------ */

function lon2x(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}
function lat2y(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

function buildTiles(layers) {
  const idx = Object.fromEntries(
    Object.entries(layers).map(([k, fs]) => [k, geojsonvt({ type: 'FeatureCollection', features: fs }, { maxZoom: MAX_Z, indexMaxZoom: MAX_Z, tolerance: 3, extent: 4096, buffer: 64 })]),
  );
  const tiles = [];
  for (let z = MIN_Z; z <= MAX_Z; z++) {
    const [x0, x1] = [lon2x(REGION.west, z), lon2x(REGION.east, z)];
    const [y0, y1] = [lat2y(REGION.north, z), lat2y(REGION.south, z)];
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const t = {};
        for (const [k, i] of Object.entries(idx)) {
          const tile = i.getTile(z, x, y);
          if (tile && tile.features.length) t[k] = tile;
        }
        if (!Object.keys(t).length) continue;
        const pbf = vtpbf.fromGeojsonVt(t, { version: 2 });
        tiles.push({ id: zxyToTileId(z, x, y), data: gzipSync(Buffer.from(pbf), { level: 9 }) });
      }
  }
  return tiles.sort((a, b) => a.id - b.id);
}

/* --------------------------- PMTiles v3 writer --------------------------- */

function varint(n, out) {
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
}

function serializeDirectory(entries) {
  const b = [];
  varint(entries.length, b);
  let last = 0;
  for (const e of entries) varint(e.tileId - last, b), (last = e.tileId);
  for (const e of entries) varint(e.runLength, b);
  for (const e of entries) varint(e.length, b);
  entries.forEach((e, i) => varint(i > 0 && e.offset === entries[i - 1].offset + entries[i - 1].length ? 0 : e.offset + 1, b));
  return gzipSync(Buffer.from(b), { level: 9 });
}

function writePmtiles(tiles, metadata) {
  const entries = [];
  let offset = 0;
  for (const t of tiles) entries.push({ tileId: t.id, offset, length: t.data.length, runLength: 1 }), (offset += t.data.length);
  const root = serializeDirectory(entries);
  if (127 + root.length > 16384) throw new Error('root directory too large – would need leaf directories');
  const meta = gzipSync(Buffer.from(JSON.stringify(metadata)));
  const data = Buffer.concat(tiles.map((t) => t.data));
  const h = Buffer.alloc(127);
  h.write('PMTiles', 0, 'ascii');
  h.writeUInt8(3, 7);
  const rootOff = 127n, metaOff = rootOff + BigInt(root.length), leafOff = metaOff + BigInt(meta.length), dataOff = leafOff;
  h.writeBigUInt64LE(rootOff, 8);
  h.writeBigUInt64LE(BigInt(root.length), 16);
  h.writeBigUInt64LE(metaOff, 24);
  h.writeBigUInt64LE(BigInt(meta.length), 32);
  h.writeBigUInt64LE(leafOff, 40);
  h.writeBigUInt64LE(0n, 48);
  h.writeBigUInt64LE(dataOff, 56);
  h.writeBigUInt64LE(BigInt(data.length), 64);
  h.writeBigUInt64LE(BigInt(tiles.length), 72); // addressed tiles
  h.writeBigUInt64LE(BigInt(tiles.length), 80); // tile entries
  h.writeBigUInt64LE(BigInt(tiles.length), 88); // tile contents
  h.writeUInt8(1, 96); // clustered
  h.writeUInt8(2, 97); // internal compression gzip
  h.writeUInt8(2, 98); // tile compression gzip
  h.writeUInt8(1, 99); // MVT
  h.writeUInt8(MIN_Z, 100);
  h.writeUInt8(MAX_Z, 101);
  h.writeInt32LE(Math.round(REGION.west * 1e7), 102);
  h.writeInt32LE(Math.round(REGION.south * 1e7), 106);
  h.writeInt32LE(Math.round(REGION.east * 1e7), 110);
  h.writeInt32LE(Math.round(REGION.north * 1e7), 114);
  h.writeUInt8(13, 118);
  h.writeInt32LE(Math.round(((REGION.west + REGION.east) / 2) * 1e7), 119);
  h.writeInt32LE(Math.round(((REGION.south + REGION.north) / 2) * 1e7), 123);
  return Buffer.concat([h, root, meta, data]);
}

/* -------------------------------- main -------------------------------- */

const src = process.argv[2];
const osm = src ? JSON.parse(readFileSync(src, 'utf8')) : existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : await fetchExtract();
if (src) {
  mkdirSync(dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, JSON.stringify(osm));
}
const layers = toLayers(osm);
const tiles = buildTiles(layers);
const attribution = '© OpenStreetMap contributors (ODbL)';
const metadata = {
  name: REGION.name,
  attribution,
  vector_layers: Object.keys(layers).map((id) => ({ id, fields: id === 'roads' || id === 'waterway' ? { class: 'String' } : {}, minzoom: MIN_Z, maxzoom: MAX_Z })),
  osm_base: osm.osm3s?.timestamp_osm_base ?? null,
};
const file = writePmtiles(tiles, metadata);
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'region.pmtiles'), file);
writeFileSync(
  join(OUT_DIR, 'region.json'),
  JSON.stringify({ name: REGION.name, bounds: [REGION.west, REGION.south, REGION.east, REGION.north], minzoom: MIN_Z, maxzoom: MAX_Z, bytes: file.length, attribution, osmBase: metadata.osm_base }, null, 2),
);
console.log(
  `features: ${Object.entries(layers).map(([k, v]) => `${k}=${v.length}`).join(' ')} · tiles z${MIN_Z}-${MAX_Z}: ${tiles.length} · region.pmtiles ${(file.length / 1048576).toFixed(2)} MB`,
);
