/**
 * IndexedDB (Dexie) – the device's source of truth. Every SOS / report /
 * allotment / photo is written HERE FIRST (§8A), then synced.
 *
 * Tables
 *  outbox : records + their delivery state (queued → sent → received)
 *  photos : downscaled JPEG + 320 px thumbnail blobs, linked to a report
 *  kv       : session, keys, snapshot, last location, settings, mesh node state, profile,
 *             cached server views (admin dashboard etc., for offline reading)
 *  shelters : shelter list for the offline map (Phase 2)
 */
import Dexie, { type Table } from 'dexie';
import type { Allotment, DeliveryState, FieldReport, MissingReport, OutboxKind, Snapshot, Sos } from '@rusq/shared';

export interface OutboxRow extends DeliveryState {
  kind: Exclude<OutboxKind, 'photo'>;
  createdAt: string;
  data: Sos | FieldReport | Allotment | MissingReport;
}

/** A shelter as cached for the offline map (sample data from the server). */
export interface ShelterRow {
  id: string;
  name: string;
  lat: number;
  lng: number;
  capacity: number | null;
  occupancy: number;
  free: number | null;
  address: string;
  phone: string;
  facilities: string[];
  sample: boolean;
}

export interface PhotoRow extends DeliveryState {
  kind: 'photo';
  reportId: string;
  createdAt: string;
  mime: 'image/jpeg';
  /** JPEG bytes. ArrayBuffer, not Blob: WebKit/Safari can fail to store Blobs in IndexedDB. */
  bytes: ArrayBuffer;
  thumbBytes: ArrayBuffer;
  width: number;
  height: number;
  /** only set when the rescuer explicitly chose to keep location (§8C) */
  location: { lat: number; lng: number } | null;
}

export interface KvRow {
  key: string;
  value: unknown;
}

class RusqDb extends Dexie {
  outbox!: Table<OutboxRow, string>;
  photos!: Table<PhotoRow, string>;
  kv!: Table<KvRow, string>;
  shelters!: Table<ShelterRow, string>;

  constructor() {
    super('rusq');
    this.version(1).stores({
      outbox: 'id, kind, status, nextAttemptAt, createdAt',
      photos: 'id, reportId, status, nextAttemptAt',
      kv: 'key',
    });
    // Phase 2: shelters for the offline map. Existing data is kept (Dexie upgrade).
    this.version(2).stores({ shelters: 'id' });
  }
}

export const db = new RusqDb();

export async function kvGet<T>(key: string): Promise<T | undefined> {
  return (await db.kv.get(key))?.value as T | undefined;
}

export async function kvSet<T>(key: string, value: T): Promise<void> {
  await db.kv.put({ key, value });
}

export async function kvDel(key: string): Promise<void> {
  await db.kv.delete(key);
}

/** Known kv keys (one place, so the setup checklist can verify them). */
export const K = {
  session: 'session',
  deviceId: 'deviceId',
  teamKey: 'teamKey',
  ackPublicJwk: 'ackPublicJwk',
  snapshot: 'snapshot',
  snapshotFetchedAt: 'snapshotFetchedAt',
  lastLocation: 'lastLocation',
  settings: 'settings',
  meshState: 'meshState',
  visionReady: 'visionReady',
  profile: 'profile',
  /** true while a locally edited profile has not been confirmed by the server */
  profileDirty: 'profileDirty',
  profileSavedAt: 'profileSavedAt',
  sheltersFetchedAt: 'sheltersFetchedAt',
  assistant: 'assistant',
} as const;

export type CachedSnapshot = Snapshot;

/** Thrown when IndexedDB is out of space – the UI shows a clear message instead of crashing. */
export class StorageFullError extends Error {
  constructor() {
    super('This phone is out of storage space. Free some space (delete photos or apps) so RusQ can save.');
  }
}

export function isQuotaError(e: unknown): boolean {
  const name = (e as { name?: string; inner?: { name?: string } })?.name ?? '';
  const inner = (e as { inner?: { name?: string } })?.inner?.name ?? '';
  return name === 'QuotaExceededError' || inner === 'QuotaExceededError' || /quota/i.test(String((e as Error)?.message ?? ''));
}

/** Wrap a write: converts quota errors into StorageFullError. */
export async function safeWrite<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isQuotaError(e)) throw new StorageFullError();
    throw e;
  }
}
