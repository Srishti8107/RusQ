/**
 * Sync engine (§8A). Runs in the page AND in the service worker (Background Sync).
 *
 * Triggers: `online` event, app open / foreground, periodic timer with
 * exponential backoff + jitter, Background Sync where supported (Android
 * Chrome), and right after something is queued.
 *
 * Status rules (§2.1): an item becomes `sent` while its request is in flight
 * and `received` ONLY when outbox.applyAck() verified the server's signature.
 */
import { backoffMs, type Ack, type SyncResponse } from '@rusq/shared';
import { api, ApiError } from './api.ts';
import { probe } from './connectivity.ts';
import { db } from './db.ts';
import { ensureAckKey } from './keys.ts';
import { applyAck, applyEvent } from './outbox.ts';
import { getSession } from './session.ts';

export interface SyncResult {
  attempted: number;
  received: number;
  failed: number;
  relayUploaded: number;
  skipped?: string;
}

let running: Promise<SyncResult> | null = null;
const listeners = new Set<(r: SyncResult) => void>();

export function onSync(l: (r: SyncResult) => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function syncNow(reason = 'manual'): Promise<SyncResult> {
  if (running) return running;
  running = doSync(reason).finally(() => (running = null));
  void running.then((r) => listeners.forEach((l) => l(r)));
  return running;
}

/** Fire-and-forget + register Background Sync so the SW retries even if the page closes. */
export function requestSync(reason: string) {
  void syncNow(reason);
  void registerBackgroundSync();
}

async function registerBackgroundSync() {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.ready;
    const sync = (reg as ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } }).sync;
    await sync?.register('rusq-sync');
  } catch {
    /* unsupported (iOS) – foreground triggers cover it */
  }
}

async function doSync(reason: string): Promise<SyncResult> {
  const res: SyncResult = { attempted: 0, received: 0, failed: 0, relayUploaded: 0 };
  if ((await probe()) !== 'online') return { ...res, skipped: 'offline' };
  if (!(await getSession())) return { ...res, skipped: 'not signed in' };
  if (!(await ensureAckKey())) return { ...res, skipped: 'no server key – cannot verify acks' };

  const now = Date.now();
  // SOS first, then reports, then allotments; oldest first within a kind.
  const order = { sos: 0, report: 1, allotment: 2 } as const;
  const due = (await db.outbox.where('nextAttemptAt').belowOrEqual(now).toArray())
    .filter((r) => r.status !== 'received')
    .sort((a, b) => order[a.kind] - order[b.kind] || a.createdAt.localeCompare(b.createdAt));

  for (let i = 0; i < due.length; i += 20) {
    const batch = due.slice(i, i + 20);
    for (const r of batch) await applyEvent(r.id, { type: 'send_started', via: 'direct' });
    res.attempted += batch.length;
    try {
      const body = await api<SyncResponse>('/sync', {
        method: 'POST',
        body: JSON.stringify({ items: batch.map((r) => ({ kind: r.kind, data: r.data })) }),
        timeoutMs: 20_000,
      });
      for (const ack of body.acks) if (await applyAck(ack)) res.received++;
      for (const rej of body.rejected) {
        res.failed++;
        const row = batch.find((b) => b.id === rej.clientId);
        await applyEvent(rej.clientId, { type: 'send_failed', error: `Rejected by server: ${rej.reason}`, nextAttemptAt: Date.now() + backoffMs((row?.attempts ?? 0) + 6, Math.random()) });
      }
      await relayLearn(body.acks);
    } catch (e) {
      await failBatch(batch, e);
      res.failed += batch.length;
      if (e instanceof ApiError && (e.status === 0 || e.status >= 500)) return res; // network down – stop this round
    }
  }

  // Photos (separate binary upload, idempotent PUT).
  const photos = (await db.photos.where('nextAttemptAt').belowOrEqual(now).toArray()).filter((p) => p.status !== 'received');
  for (const p of photos) {
    await applyEvent(p.id, { type: 'send_started', via: 'direct' });
    res.attempted++;
    try {
      const s = await getSession();
      const r = await fetch(`/api/photos/${p.id}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${s?.token}`, 'content-type': p.mime, 'x-report-id': p.reportId },
        body: p.bytes,
      });
      if (!r.ok) throw new ApiError(r.status, await r.text());
      const ack = (await r.json()) as Ack;
      if (await applyAck(ack)) res.received++;
      await relayLearn([ack]);
    } catch (e) {
      await failBatch([p], e);
      res.failed++;
    }
  }

  // Gateway behaviour: upload what nearby phones handed us over the LAN link.
  try {
    const { gatewayUpload } = await import('./relay.ts');
    res.relayUploaded = await gatewayUpload();
  } catch {
    /* relay not provisioned */
  }
  void reason;
  return res;
}

async function failBatch(rows: { id: string; attempts: number }[], e: unknown) {
  const msg = e instanceof ApiError ? (e.status ? `Server error ${e.status}: ${e.message}` : 'No connection') : String(e);
  for (const r of rows) {
    await applyEvent(r.id, { type: 'send_failed', error: msg, nextAttemptAt: Date.now() + backoffMs(r.attempts, Math.random()) });
  }
}

/** Tell the local relay node about acks so it stops forwarding and informs peers. */
async function relayLearn(acks: Ack[]) {
  if (acks.length === 0) return;
  try {
    const { learnAcks } = await import('./relay.ts');
    await learnAcks(acks);
  } catch {
    /* not provisioned */
  }
}

/* ---------------------- foreground scheduler (page) ---------------------- */

let timer: ReturnType<typeof setTimeout> | null = null;
let idleRounds = 0;

/** Page-side retry loop: backs off while nothing changes, resets on events. */
export function startSyncScheduler() {
  const kick = () => {
    idleRounds = 0;
    void syncNow('event');
  };
  window.addEventListener('online', kick);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') kick();
  });
  const loop = async () => {
    const r = await syncNow('timer').catch(() => null);
    idleRounds = r && r.received > 0 ? 0 : idleRounds + 1;
    timer = setTimeout(loop, backoffMs(Math.min(idleRounds, 6), Math.random(), 5000, 120_000));
  };
  if (!timer) timer = setTimeout(loop, 1000);
  kick();
}
