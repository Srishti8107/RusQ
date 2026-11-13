/**
 * "Ready for offline" checklist (§5). Each item has a download step and an
 * independent VERIFY step that inspects what is really stored on the phone
 * (Cache API / IndexedDB). An item turns green only when verify() passes.
 */
import { Snapshot } from '@rusq/shared';
import { api } from './api.ts';
import { db, kvGet, kvSet, K } from './db.ts';
import { downloadMapRegion, downloadShelters, MAP_INFO, verifyMapStored } from './offline-map.ts';
import { getAckPublicKey, getTeamKey, provisionKeys } from './keys.ts';
import { permissionState, refreshLastKnown } from './location.ts';
import { resetRelayNode } from './relay.ts';
import type { Role } from '@rusq/shared';
import { downloadModelFiles, loadVision, modelFiles, verifyModelsStored } from './vision.ts';

export type ItemId = 'shell' | 'keys' | 'snapshot' | 'map' | 'shelters' | 'vision' | 'location' | 'storage';

export interface CheckItem {
  id: ItemId;
  label: string;
  why: string;
  roles: Role[];
  sizeBytes?: () => Promise<number | null>;
  download?: (progress: (msg: string) => void) => Promise<void>;
  verify: () => Promise<{ ok: boolean; detail: string }>;
}

export const CHECKLIST: CheckItem[] = [
  {
    id: 'shell',
    label: 'App works offline',
    why: 'The app itself is saved on this phone so it opens without internet.',
    roles: ['victim', 'rescuer', 'admin'],
    sizeBytes: async () => {
      try {
        const keys = (await caches.keys()).filter((k) => k.startsWith('workbox-precache'));
        let total = 0;
        for (const k of keys) for (const req of await (await caches.open(k)).keys()) total += Number((await caches.match(req))?.headers.get('content-length') ?? 0);
        return total || null;
      } catch {
        return null;
      }
    },
    download: async () => {
      await navigator.serviceWorker?.ready;
    },
    verify: async () => {
      if (!('serviceWorker' in navigator)) return { ok: false, detail: 'This browser cannot work offline (no service worker).' };
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg?.active) return { ok: false, detail: 'Still installing…' };
      const keys = (await caches.keys()).filter((k) => k.startsWith('workbox-precache'));
      for (const k of keys) {
        const c = await caches.open(k);
        const html = (await c.keys()).find((r) => new URL(r.url).pathname === '/index.html');
        if (html && (await c.match(html))) return { ok: true, detail: `Saved (${(await c.keys()).length} files)` };
      }
      return { ok: false, detail: 'App files not saved yet.' };
    },
  },
  {
    id: 'keys',
    label: 'Team key',
    why: 'Lets this phone pass messages to nearby phones safely, and check that replies really come from the control room.',
    roles: ['victim', 'rescuer', 'admin'],
    download: async () => {
      await provisionKeys();
      resetRelayNode();
    },
    verify: async () => {
      const [t, a] = await Promise.all([getTeamKey(), getAckPublicKey()]);
      return t && a ? { ok: true, detail: 'Saved' } : { ok: false, detail: 'Not saved yet' };
    },
  },
  {
    id: 'snapshot',
    label: 'Resource snapshot',
    why: 'Stock levels and needs, so this phone can suggest a fair share offline.',
    roles: ['rescuer', 'admin'],
    sizeBytes: async () => {
      const s = await kvGet<Snapshot>(K.snapshot);
      return s ? JSON.stringify(s).length : null;
    },
    download: async () => {
      const snap = Snapshot.parse(await api('/snapshot'));
      await kvSet(K.snapshot, snap);
      await kvSet(K.snapshotFetchedAt, new Date().toISOString());
    },
    verify: async () => {
      const s = await kvGet<Snapshot>(K.snapshot);
      if (!s) return { ok: false, detail: 'Not saved yet' };
      return Snapshot.safeParse(s).success ? { ok: true, detail: `Version ${s.version}` } : { ok: false, detail: 'Saved copy is damaged – download again' };
    },
  },
  {
    id: 'map',
    label: 'Map of your area',
    why: 'Streets, rivers and shelters of the sample region, so the map opens without internet.',
    roles: ['victim', 'rescuer', 'admin'],
    sizeBytes: async () => {
      try {
        return ((await (await fetch(MAP_INFO)).json()) as { bytes: number }).bytes;
      } catch {
        return (await verifyMapStored()).bytes ?? null;
      }
    },
    download: async () => {
      await downloadMapRegion();
    },
    verify: verifyMapStored,
  },
  {
    id: 'shelters',
    label: 'Shelters list',
    why: 'Names, addresses, phone numbers and free places of shelters, available without internet.',
    roles: ['victim', 'rescuer', 'admin'],
    sizeBytes: async () => {
      const rows = await db.shelters.toArray();
      return rows.length ? JSON.stringify(rows).length : null;
    },
    download: async () => {
      await downloadShelters();
    },
    verify: async () => {
      const n = await db.shelters.count();
      return n > 0 ? { ok: true, detail: `${n} shelters saved` } : { ok: false, detail: 'Not saved yet' };
    },
  },
  {
    id: 'vision',
    label: 'Photo helper (vision models)',
    why: 'Suggests hazards and counts people in photos – works offline. About 116 MB.',
    roles: ['rescuer'],
    sizeBytes: async () => {
      try {
        return (await modelFiles()).reduce((s, f) => s + f.bytes, 0) + 21_650_000;
      } catch {
        return null;
      }
    },
    download: async (progress) => {
      await downloadModelFiles((d, t) => progress(`${Math.round((100 * d) / t)} %`));
      progress('Loading the models once to check they work…');
      const r = await loadVision();
      await kvSet(K.visionReady, { backend: r.backend, at: new Date().toISOString() });
    },
    verify: async () => {
      const v = await verifyModelsStored();
      if (!v.ok) return { ok: false, detail: `Missing: ${v.missing.slice(0, 2).join(', ')}${v.missing.length > 2 ? '…' : ''}` };
      const ready = await kvGet<{ backend: string }>(K.visionReady);
      return { ok: true, detail: ready ? `Saved – tested with ${ready.backend.toUpperCase()}` : 'Saved' };
    },
  },
  {
    id: 'location',
    label: 'Location permission',
    why: 'GPS works without internet. Allow it now so SOS can include where you are.',
    roles: ['victim', 'rescuer', 'admin'],
    download: async () => {
      await refreshLastKnown();
    },
    verify: async () => {
      const s = await permissionState();
      if (s === 'granted') return { ok: true, detail: 'Allowed' };
      if (s === 'unsupported') {
        const last = await kvGet(K.lastLocation);
        return last ? { ok: true, detail: 'Location saved' } : { ok: false, detail: 'Tap to allow' };
      }
      return { ok: false, detail: s === 'denied' ? 'Blocked – allow location in phone settings' : 'Tap to allow' };
    },
  },
  {
    id: 'storage',
    label: 'Keep data safe (persistent storage)',
    why: 'Asks the phone not to delete RusQ data when space runs low.',
    roles: ['victim', 'rescuer', 'admin'],
    download: async () => {
      await navigator.storage?.persist?.();
    },
    verify: async () => {
      const persisted = (await navigator.storage?.persisted?.()) ?? false;
      return persisted ? { ok: true, detail: 'Protected' } : { ok: false, detail: 'Not protected – the phone may clear data if storage is low' };
    },
  },
];

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage.estimate();
    return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
  } catch {
    return null;
  }
}

export function mb(bytes: number | null | undefined): string {
  if (bytes == null) return '–';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
