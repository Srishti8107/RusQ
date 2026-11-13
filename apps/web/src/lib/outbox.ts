/**
 * Outbox: every SOS / report / allotment / photo is saved to IndexedDB FIRST
 * with status `queued` (§2.1, §8A). Nothing here ever sets `received` – only
 * sync.ts / relay.ts do, through the shared state machine, after a verified ack.
 */
import {
  applyDeliveryEvent,
  newDeliveryState,
  type Ack,
  type Allotment,
  type DeliveryEvent,
  type FieldReport,
  type MissingReport,
  type Sos,
} from '@rusq/shared';
import { db, safeWrite, type OutboxRow, type PhotoRow } from './db.ts';
import { verifyAck } from '@rusq/shared';
import { getAckPublicKey } from './keys.ts';

export async function queueSos(sos: Sos): Promise<OutboxRow> {
  return queueRecord('sos', sos);
}
export async function queueReport(r: FieldReport): Promise<OutboxRow> {
  return queueRecord('report', r);
}
export async function queueAllotment(a: Allotment): Promise<OutboxRow> {
  return queueRecord('allotment', a);
}
/** Phase 2: a family's missing-person report – same honest queued → sent → received path. */
export async function queueMissing(m: MissingReport): Promise<OutboxRow> {
  return queueRecord('missing', m);
}

async function queueRecord(kind: OutboxRow['kind'], data: OutboxRow['data']): Promise<OutboxRow> {
  const existing = await db.outbox.get(data.id);
  if (existing) return existing; // idempotent locally too
  const row: OutboxRow = { ...newDeliveryState(data.id, kind), kind, createdAt: data.createdAt, data };
  await safeWrite(() => db.outbox.put(row));
  void afterQueue(row);
  return row;
}

export async function queuePhoto(p: Omit<PhotoRow, keyof ReturnType<typeof newDeliveryState> | 'kind'> & { id: string }): Promise<PhotoRow> {
  const row: PhotoRow = { ...newDeliveryState(p.id, 'photo'), kind: 'photo', ...p };
  await safeWrite(() => db.photos.put(row));
  return row;
}

/** Hand the new record to the relay node and ask for a sync (both best-effort). */
async function afterQueue(row: OutboxRow) {
  try {
    const { originateRecord } = await import('./relay.ts');
    await originateRecord(row.kind, row.data);
  } catch {
    /* relay not provisioned yet – record still syncs directly */
  }
  try {
    const { requestSync } = await import('./sync.ts');
    requestSync('queued');
  } catch {
    /* ignore */
  }
}

/** Apply a delivery event to an outbox or photo row (atomic read-modify-write). */
export async function applyEvent(id: string, ev: DeliveryEvent): Promise<void> {
  await db.transaction('rw', db.outbox, db.photos, async () => {
    const o = await db.outbox.get(id);
    if (o) {
      const next = applyDeliveryEvent(o, ev);
      if (next !== o) await db.outbox.put({ ...o, ...next, kind: o.kind });
      return;
    }
    const p = await db.photos.get(id);
    if (p) {
      const next = applyDeliveryEvent(p, ev);
      if (next !== p) await db.photos.put({ ...p, ...next, kind: p.kind });
    }
  });
}

/**
 * The ONLY entry point that can move an item to `received`: verifies the server
 * ECDSA signature with the cached public key, then feeds the shared state machine.
 */
export async function applyAck(ack: Ack): Promise<boolean> {
  const key = await getAckPublicKey();
  const ok = !!key && (await verifyAck(key, ack));
  await applyEvent(ack.clientId, { type: 'ack', ack, signatureVerified: ok });
  return ok;
}

export async function markSentViaRelay(ids: string[]) {
  for (const id of ids) {
    const row = (await db.outbox.get(id)) ?? (await db.photos.get(id));
    if (row && row.status === 'queued') await applyEvent(id, { type: 'send_started', via: 'relay' });
  }
}
