/**
 * Offline shelter map data (Phase 2, §4):
 *  - the sample-region vector tiles: ONE self-hosted PMTiles file, stored in the
 *    Cache API ("rusq-map") during setup, read back fully into memory (0.8 MB),
 *    so no HTTP range requests are needed offline;
 *  - the shelter list, stored in IndexedDB (Dexie `shelters`).
 */
import { api } from './api.ts';
import { db, kvGet, kvSet, K, safeWrite, type ShelterRow } from './db.ts';

export const MAP_CACHE = 'rusq-map';
export const MAP_FILE = '/map/region.pmtiles';
export const MAP_INFO = '/map/region.json';

export interface RegionInfo {
  name: string;
  bounds: [number, number, number, number];
  minzoom: number;
  maxzoom: number;
  bytes: number;
  attribution: string;
}

export async function downloadMapRegion(): Promise<void> {
  const cache = await caches.open(MAP_CACHE);
  for (const url of [MAP_INFO, MAP_FILE]) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`map download failed (${res.status})`);
    await cache.put(url, res);
  }
}

/** Verified only if the cached file has exactly the size the region info says. */
export async function verifyMapStored(): Promise<{ ok: boolean; detail: string; bytes?: number }> {
  try {
    const cache = await caches.open(MAP_CACHE);
    const infoRes = await cache.match(MAP_INFO);
    const fileRes = await cache.match(MAP_FILE);
    if (!infoRes || !fileRes) return { ok: false, detail: 'Not saved yet' };
    const info = (await infoRes.json()) as RegionInfo;
    const bytes = (await fileRes.arrayBuffer()).byteLength;
    if (bytes !== info.bytes) return { ok: false, detail: 'Saved copy is incomplete – download again' };
    return { ok: true, detail: `${info.name} saved`, bytes };
  } catch {
    return { ok: false, detail: 'Not saved yet' };
  }
}

export async function regionInfo(): Promise<RegionInfo | null> {
  const r = (await caches.open(MAP_CACHE).then((c) => c.match(MAP_INFO)).catch(() => undefined)) ?? (await fetch(MAP_INFO).catch(() => undefined));
  return r && r.ok ? ((await r.json()) as RegionInfo) : null;
}

/** The whole PMTiles archive: from the offline cache first, else the network. */
export async function loadRegionBuffer(): Promise<{ buf: ArrayBuffer; fromCache: boolean }> {
  const cached = await caches
    .open(MAP_CACHE)
    .then((c) => c.match(MAP_FILE))
    .catch(() => undefined);
  if (cached) return { buf: await cached.arrayBuffer(), fromCache: true };
  const res = await fetch(MAP_FILE);
  if (!res.ok) throw new Error('The map is not saved on this phone yet. Open “Ready for offline” while connected.');
  return { buf: await res.arrayBuffer(), fromCache: false };
}

/* ------------------------------ shelters ------------------------------ */

export async function downloadShelters(): Promise<number> {
  const r = await api<{ shelters: ShelterRow[] }>('/shelters');
  await safeWrite(() =>
    db.transaction('rw', db.shelters, async () => {
      await db.shelters.clear();
      await db.shelters.bulkPut(r.shelters);
    }),
  );
  await kvSet(K.sheltersFetchedAt, new Date().toISOString());
  return r.shelters.length;
}

export async function sheltersFetchedAt(): Promise<string | null> {
  return (await kvGet<string>(K.sheltersFetchedAt)) ?? null;
}
