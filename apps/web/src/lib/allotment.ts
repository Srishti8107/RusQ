/**
 * On-device provisional allotment (§8B): runs the SHARED engine against the
 * cached snapshot, subtracting what this phone already provisionally claimed.
 */
import {
  computeProvisionalAllotment,
  isSnapshotStale,
  snapshotAgeMs,
  sumClaims,
  uuidv7,
  type Allotment,
  type FieldReport,
  type ResourceQty,
  type Snapshot,
} from '@rusq/shared';
import { db, kvGet, K } from './db.ts';
import { getDeviceId, getSettings } from './session.ts';

export async function cachedSnapshot(): Promise<Snapshot | null> {
  return (await kvGet<Snapshot>(K.snapshot)) ?? null;
}

/**
 * This device's claims made against the CURRENT snapshot version. A newer
 * snapshot already reflects admin decisions, so older claims no longer count.
 */
export async function alreadyAllotted(snapshotVersion?: number): Promise<ResourceQty> {
  const version = snapshotVersion ?? (await cachedSnapshot())?.version;
  const rows = await db.outbox.where('kind').equals('allotment').toArray();
  return sumClaims(rows.map((r) => r.data as Allotment).filter((a) => a.snapshotVersion === version));
}

export async function snapshotStatus(nowMs = Date.now()) {
  const snap = await cachedSnapshot();
  const { staleHours } = await getSettings();
  if (!snap) return { snap: null, ageMs: null, stale: true };
  return { snap, ageMs: snapshotAgeMs(snap, nowMs), stale: isSnapshotStale(snap, nowMs, staleHours * 3600_000) };
}

export async function provisionalFor(report: Pick<FieldReport, 'id' | 'victimCount' | 'urgency' | 'requested'>) {
  const snap = await cachedSnapshot();
  if (!snap) throw new Error('No resource snapshot on this phone. Open "Ready for offline" while connected.');
  const already = await alreadyAllotted();
  return {
    already,
    ...computeProvisionalAllotment({
      snapshot: snap,
      report,
      deviceId: await getDeviceId(),
      alreadyAllotted: already,
      id: uuidv7(),
      createdAt: new Date().toISOString(),
    }),
  };
}
