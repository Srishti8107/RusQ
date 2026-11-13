/**
 * Builds REAL background data for the Kathmandu sample region from public datasets on the
 * ResQGrid source list → apps/server/src/nepal/kathmandu-context.json
 *
 *  Residents        WorldPop R2025A, 2024, constrained, 100 m (CC BY 4.0). Modelled estimate of
 *                   people LIVING there (≈1.2 M in the box – consistent with Census 2021 for the
 *                   Kathmandu + Lalitpur metropolitan cities). Not people needing help.
 *  Flood-prone land Terrain model "height above nearest drainage" (HAND): Copernicus DEM GLO-30
 *                   + OpenStreetMap rivers. A 30 m cell is HIGH when it lies ≤ 3 m above the river
 *                   it drains to and ≤ 600 m from it, MODERATE when ≤ 6 m. Susceptibility, not an
 *                   observed flood.
 *  Rivers           OpenStreetMap waterways (HOT export, ODbL) – named rivers for the map.
 *  Health           OpenStreetMap hospitals / clinics (HOT export, ODbL).
 *
 *  Not used, on purpose: UNOSAT's public 2024 Sentinel-1 flood layers stop at 84.97° E (no
 *  Kathmandu; the Kathmandu SPOT-6 vectors of product 3993 are not in the published package), and
 *  the Zenodo 2019–2023 NDVI flood rasters mark roofs and roads in the city as "flooded".
 *
 * Inputs in data/nepal/ (not in git) – download commands in docs/NEPAL_DATA.md:
 *   npl_pop_2024_CN_100m_R2025A_v1.tif, waterways/waterways.geojson, health/health_facilities.geojson
 * The DEM window is read directly from the AWS open-data bucket (Cloud-Optimised GeoTIFF).
 *
 *   node --max-old-space-size=4096 scripts/build-nepal-data.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fromFile, fromUrl } from 'geotiff';
import sharp from 'sharp';

const DATA = 'data/nepal';
const OUT = 'apps/server/src/nepal/kathmandu-context.json';
const region = JSON.parse(readFileSync('apps/web/public/map/region.json', 'utf8'));
const [W, S, E, N] = region.bounds;
const HIGH_M = Number(process.env.HIGH_M ?? 3);
const MOD_M = Number(process.env.MOD_M ?? 6);
const MAX_DIST = Number(process.env.MAX_DIST ?? 600);
const PAD = 0.02; // read rivers / terrain a little beyond the box so edge cells see their river
const r5 = (x) => Math.round(x * 1e5) / 1e5;
const cellKey = (lat, lng) => `c${Math.floor(lat * 100)}_${Math.floor(lng * 100)}`;
const inBox = (lat, lng) => lng >= W && lng <= E && lat >= S && lat <= N;

/* ------------------------------ DEM (Copernicus GLO-30) ------------------------------ */

const DEM_URL = 'https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N27_00_E085_00_DEM/Copernicus_DSM_COG_10_N27_00_E085_00_DEM.tif';
const dem = await (await fromUrl(DEM_URL)).getImage();
const [dox, doy] = dem.getOrigin();
const [drx, dry] = dem.getResolution();
const gx0 = Math.floor((W - PAD - dox) / drx);
const gx1 = Math.ceil((E + PAD - dox) / drx);
const gy0 = Math.floor((N + PAD - doy) / dry);
const gy1 = Math.ceil((S - PAD - doy) / dry);
const GW = gx1 - gx0;
const GH = gy1 - gy0;
const [elev] = await dem.readRasters({ window: [gx0, gy0, gx1, gy1] });
const lngOf = (x) => dox + (gx0 + x + 0.5) * drx;
const latOf = (y) => doy + (gy0 + y + 0.5) * dry;
const gxOf = (lng) => Math.floor((lng - dox) / drx) - gx0;
const gyOf = (lat) => Math.floor((lat - doy) / dry) - gy0;

/* ------------------------------ rivers (OSM) ------------------------------ */

const ww = JSON.parse(readFileSync(`${DATA}/waterways/waterways.geojson`, 'utf8'));
const rivers = [];
for (const f of ww.features) {
  const p = f.properties ?? {};
  if (p.waterway !== 'river') continue;
  const lines = f.geometry?.type === 'LineString' ? [f.geometry.coordinates] : f.geometry?.type === 'MultiLineString' ? f.geometry.coordinates : [];
  for (const l of lines) {
    if (!l.some(([x, y]) => x >= W - PAD && x <= E + PAD && y >= S - PAD && y <= N + PAD)) continue;
    rivers.push({ name: p['name:en'] || p.name || 'River', coords: l });
  }
}
ww.features = null;

// rasterise river lines onto the DEM grid (dense sampling ≈ 10 m)
const isRiver = new Uint8Array(GW * GH);
for (const r of rivers) {
  for (let i = 0; i + 1 < r.coords.length; i++) {
    const [ax, ay] = r.coords[i];
    const [bx, by] = r.coords[i + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.0001));
    for (let s = 0; s <= steps; s++) {
      const x = gxOf(ax + ((bx - ax) * s) / steps);
      const y = gyOf(ay + ((by - ay) * s) / steps);
      if (x >= 0 && y >= 0 && x < GW && y < GH) isRiver[y * GW + x] = 1;
    }
  }
}

/* HAND-lite: each cell drains to its nearest river cell (multi-source BFS, 8-neighbour);
   height above it = cell elevation − lowest river elevation within 2 cells of that river cell. */
const riverBase = new Float32Array(GW * GH).fill(NaN);
for (let y = 0; y < GH; y++)
  for (let x = 0; x < GW; x++) {
    if (!isRiver[y * GW + x]) continue;
    let m = elev[y * GW + x];
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < GW && yy < GH && isRiver[yy * GW + xx]) m = Math.min(m, elev[yy * GW + xx]);
      }
    riverBase[y * GW + x] = m;
  }
const src = new Int32Array(GW * GH).fill(-1);
const queue = new Int32Array(GW * GH);
let qh = 0;
let qt = 0;
for (let i = 0; i < GW * GH; i++) if (isRiver[i]) (src[i] = i), (queue[qt++] = i);
while (qh < qt) {
  const i = queue[qh++];
  const x = i % GW;
  const y = (i / GW) | 0;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx;
      const yy = y + dy;
      if ((dx || dy) && xx >= 0 && yy >= 0 && xx < GW && yy < GH && src[yy * GW + xx] < 0) {
        src[yy * GW + xx] = src[i];
        queue[qt++] = yy * GW + xx;
      }
    }
}
const mPerDegLat = 110574;
const mPerDegLng = 111320 * Math.cos((((S + N) / 2) * Math.PI) / 180);
const level = new Uint8Array(GW * GH); // 0 none · 1 moderate · 2 high
for (let i = 0; i < GW * GH; i++) {
  const s = src[i];
  if (s < 0) continue;
  const hand = elev[i] - riverBase[s];
  const dist = Math.hypot(((i % GW) - (s % GW)) * drx * mPerDegLng, (((i / GW) | 0) - ((s / GW) | 0)) * dry * mPerDegLat);
  if (dist > MAX_DIST) continue;
  level[i] = hand <= HIGH_M ? 2 : hand <= MOD_M ? 1 : 0;
}
const levelAt = (lat, lng) => {
  const x = gxOf(lng);
  const y = gyOf(lat);
  return x >= 0 && y >= 0 && x < GW && y < GH ? level[y * GW + x] : 0;
};

/* ------------------------------ residents (WorldPop 2024) ------------------------------ */

const wp = await (await fromFile(`${DATA}/npl_pop_2024_CN_100m_R2025A_v1.tif`)).getImage();
const [pox, poy] = wp.getOrigin();
const [prx, pry] = wp.getResolution();
const px0 = Math.floor((W - pox) / prx);
const px1 = Math.ceil((E - pox) / prx);
const py0 = Math.floor((N - poy) / pry);
const py1 = Math.ceil((S - poy) / pry);
const [pop] = await wp.readRasters({ window: [px0, py0, px1, py1] });

const cells = {};
const cell = (k) => (cells[k] ??= { residents: 0, residentsFloodProne: 0, high: 0, moderate: 0, n: 0 });
let residents = 0;
let residentsHigh = 0;
for (let j = 0; j < py1 - py0; j++)
  for (let i = 0; i < px1 - px0; i++) {
    const v = pop[j * (px1 - px0) + i];
    if (!(v > 0)) continue;
    const lng = pox + (px0 + i + 0.5) * prx;
    const lat = poy + (py0 + j + 0.5) * pry;
    if (!inBox(lat, lng)) continue;
    const c = cell(cellKey(lat, lng));
    c.residents += v;
    residents += v;
    if (levelAt(lat, lng) === 2) {
      c.residentsFloodProne += v;
      residentsHigh += v;
    }
  }
let highKm2 = 0;
let modKm2 = 0;
const cellArea = (Math.abs(drx * dry) * mPerDegLat * mPerDegLng) / 1e6;
for (let y = 0; y < GH; y++)
  for (let x = 0; x < GW; x++) {
    const lat = latOf(y);
    const lng = lngOf(x);
    if (!inBox(lat, lng)) continue;
    const c = cell(cellKey(lat, lng));
    c.n++;
    if (level[y * GW + x] === 2) {
      c.high++;
      highKm2 += cellArea;
    } else if (level[y * GW + x] === 1) {
      c.moderate++;
      modKm2 += cellArea;
    }
  }
const cellsOut = {};
for (const [k, c] of Object.entries(cells)) {
  if (!c.n) continue;
  cellsOut[k] = {
    residents: Math.round(c.residents),
    residentsFloodProne: Math.round(c.residentsFloodProne),
    floodProneShare: +(c.high / c.n).toFixed(3),
    moderateShare: +(c.moderate / c.n).toFixed(3),
  };
}

/* ------------------------------ map layers ------------------------------ */

// susceptibility as a transparent PNG over the exact box (MapLibre image source)
const bx0 = gxOf(W);
const bx1 = gxOf(E);
const by0 = gyOf(N);
const by1 = gyOf(S);
const IW = bx1 - bx0;
const IH = by1 - by0;
const rgba = Buffer.alloc(IW * IH * 4);
for (let y = 0; y < IH; y++)
  for (let x = 0; x < IW; x++) {
    const l = level[(by0 + y) * GW + bx0 + x];
    const o = (y * IW + x) * 4;
    if (l === 2) rgba.set([31, 111, 178, 170], o);
    else if (l === 1) rgba.set([120, 170, 220, 110], o);
  }
const png = await sharp(rgba, { raw: { width: IW, height: IH, channels: 4 } }).png({ compressionLevel: 9, palette: true }).toBuffer();
const imgW = lngOf(bx0) - drx / 2;
const imgE = lngOf(bx1 - 1) + drx / 2;
const imgN = latOf(by0) - dry / 2;
const imgS = latOf(by1 - 1) + dry / 2;

function simplify(line, tol) {
  if (line.length < 3) return line;
  const keep = new Uint8Array(line.length);
  keep[0] = keep[line.length - 1] = 1;
  const st = [[0, line.length - 1]];
  while (st.length) {
    const [a, b] = st.pop();
    const [ax, ay] = line[a];
    const [bx, by] = line[b];
    const L = Math.hypot(bx - ax, by - ay) || 1e-12;
    let best = -1;
    let bi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((by - ay) * line[i][0] - (bx - ax) * line[i][1] + bx * ay - by * ax) / L;
      if (d > best) [best, bi] = [d, i];
    }
    if (best > tol) {
      keep[bi] = 1;
      st.push([a, bi], [bi, b]);
    }
  }
  return line.filter((_, i) => keep[i]);
}
const riverFeatures = rivers
  .map((r) => ({ type: 'Feature', properties: { name: r.name }, geometry: { type: 'LineString', coordinates: simplify(r.coords, 0.00005).map(([x, y]) => [r5(x), r5(y)]) } }))
  .filter((f) => f.geometry.coordinates.length >= 2);

/* ------------------------------ health facilities (OSM) ------------------------------ */

const hf = JSON.parse(readFileSync(`${DATA}/health/health_facilities.geojson`, 'utf8'));
const seen = new Set();
const hospitals = [];
for (const ft of hf.features ?? []) {
  const p = ft.properties ?? {};
  const kind = ['hospital', 'clinic'].includes(p.amenity) ? p.amenity : ['hospital', 'clinic'].includes(p.healthcare) ? p.healthcare : null;
  if (!kind || !p.name) continue;
  const g = ft.geometry;
  let lng;
  let lat;
  if (g?.type === 'Point') [lng, lat] = g.coordinates;
  else if (g?.type === 'Polygon' || g?.type === 'MultiPolygon') {
    const ring = g.type === 'Polygon' ? g.coordinates[0] : g.coordinates[0][0];
    lng = ring.reduce((s, q) => s + q[0], 0) / ring.length;
    lat = ring.reduce((s, q) => s + q[1], 0) / ring.length;
  } else continue;
  if (!inBox(lat, lng)) continue;
  const key = `${String(p.name).toLowerCase()}|${lat.toFixed(3)}|${lng.toFixed(3)}`;
  if (seen.has(key)) continue;
  seen.add(key);
  hospitals.push({ id: `osm-${p.osm_type ?? 'n'}${p.osm_id ?? hospitals.length}`, name: String(p.name).slice(0, 80), kind, lat: r5(lat), lng: r5(lng), emergency: p.emergency === 'yes' || undefined, floodProne: levelAt(lat, lng) === 2 || undefined });
}
hospitals.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'hospital' ? -1 : 1));

/* ------------------------------ output ------------------------------ */

const out = {
  region: { name: region.name, bounds: region.bounds },
  sources: {
    residents: { title: 'WorldPop R2025A – population 2024, constrained, 100 m (npl_pop_2024_CN_100m)', url: 'https://hub.worldpop.org/', license: 'CC BY 4.0', caution: 'Modelled estimate of residents – not a count of people affected or needing help.' },
    terrain: {
      title: 'Flood-prone land: height above nearest river from the Copernicus DEM GLO-30 + OpenStreetMap rivers',
      url: 'https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM',
      license: 'Copernicus DEM © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA; rivers © OpenStreetMap contributors (ODbL)',
      caution: 'Terrain susceptibility (≤ 3 m above the river and ≤ 600 m from it = high; ≤ 6 m = moderate), not an observed flood. The 30 m DEM includes buildings and trees.',
    },
    health: { title: 'Hospitals and clinics – OpenStreetMap (HOT export)', url: 'https://data.humdata.org/dataset/hotosm_npl_health_facilities', license: 'ODbL – © OpenStreetMap contributors', caution: 'OSM completeness varies; a missing facility may still exist.' },
  },
  totals: { residents: Math.round(residents), residentsFloodProne: Math.round(residentsHigh), floodProneKm2: +highKm2.toFixed(2), moderateKm2: +modKm2.toFixed(2) },
  cells: cellsOut,
  hospitals,
  rivers: { type: 'FeatureCollection', features: riverFeatures },
  floodProneImage: {
    url: `data:image/png;base64,${png.toString('base64')}`,
    coordinates: [
      [r5(imgW), r5(imgN)],
      [r5(imgE), r5(imgN)],
      [r5(imgE), r5(imgS)],
      [r5(imgW), r5(imgS)],
    ],
  },
};
mkdirSync('apps/server/src/nepal', { recursive: true });
writeFileSync(OUT, JSON.stringify(out));
writeFileSync(`${DATA}/flood-prone-preview.png`, png);
console.log({
  demGrid: [GW, GH],
  rivers: riverFeatures.length,
  riverNames: [...new Set(rivers.map((r) => r.name))].join(', '),
  cells: Object.keys(cellsOut).length,
  ...out.totals,
  hospitals: hospitals.filter((h) => h.kind === 'hospital').length,
  clinics: hospitals.filter((h) => h.kind === 'clinic').length,
  floodProneHospitals: hospitals.filter((h) => h.floodProne).map((h) => h.name).join('; '),
  pngBytes: png.length,
  jsonBytes: JSON.stringify(out).length,
});
