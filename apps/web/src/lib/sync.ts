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
import { apiUrl } from './platform.ts';
import { backoffMs, type Ack, type SyncResponse } from '@rusq/shared';
import { api, ApiError, friendlyError, NO_CONNECTION } from './api.ts';
import { onReachChange, probe } from './connectivity.ts';
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

/**
 * Connection is back → everything waiting is due NOW (decisions.md 12.4). Without this, an item
 * that failed on a flaky link waited out its backoff (up to 5 minutes) even though the
 * connection had returned – which is why people pressed "Send now".
 */
export async function makeAllDue(): Promise<number> {
  const now = Date.now();
  let n = 0;
  await db.transaction('rw', db.outbox, db.photos, async () => {
    for (const t of [db.outbox, db.photos] as const) {
      const rows = (await t.where('nextAttemptAt').above(now).toArray()) as { id: string; status: string }[];
      for (const r of rows) {
        if (r.status === 'received') continue;
        await t.update(r.id, { nextAttemptAt: now });
        n++;
      }
    }
  });
  return n;
}

async function doSync(reason: string): Promise<SyncResult> {
  const res: SyncResult = { attempted: 0, received: 0, failed: 0, relayUploaded: 0 };
  if ((await probe()) !== 'online') return { ...res, skipped: 'offline' };
  if (!(await getSession())) return { ...res, skipped: 'not signed in' };
  if (!(await ensureAckKey())) return { ...res, skipped: 'no server key – cannot verify acks' };

  const now = Date.now();
  // SOS first, then missing-person reports, reports, allotments; oldest first within a kind.
  const order = { sos: 0, missing: 1, report: 2, allotment: 3 } as const;
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
      const r = await fetch(apiUrl(`/photos/${p.id}`), {
        method: 'PUT',
        headers: { authorization: `Bearer ${s?.token}`, 'content-type': p.mime, 'x-report-id': p.reportId },
        body: p.bytes,
      });
      const text = await r.text();
      let ack: Ack;
      try {
        ack = JSON.parse(text) as Ack;
      } catch {
        throw new ApiError(0, NO_CONNECTION); // proxy / tunnel error page, not the server
      }
      if (!r.ok) throw new ApiError(r.status, (ack as unknown as { error?: string }).error ?? `error ${r.status}`);
      if (await applyAck(ack)) res.received++;
      await relayLearn([ack]);
    } catch (e) {
      await failBatch([p], e);
      res.failed++;
    }
  }

  // Profile edits made offline (Phase 2).
  try {
    const { uploadProfileIfDirty } = await import('./profile.ts');
    await uploadProfileIfDirty();
  } catch {
    /* retried next round */
  }

  // Short codes other rescuers sent this phone by SMS / read out.
  try {
    const { uploadReceived } = await import('./shortcodes.ts');
    res.received += await uploadReceived();
  } catch {
    /* retried next round */
  }

  // Gateway behaviour: upload what nearby phones handed us over the LAN link.
  try {
    const { gatewayUpload } = await import('./relay.ts');
    res.relayUploaded = await gatewayUpload();
  } catch {
    /* relay not provisioned */
  }
  if (res.received > 0) void notifyDelivered().catch(() => {});
  void reason;
  return res;
}

async function failBatch(rows: { id: string; attempts: number }[], e: unknown) {
  const msg = e instanceof ApiError ? (e.status ? `Server error ${e.status}: ${friendlyError(e)}` : 'No connection') : friendlyError(e);
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

/**
 * Page-side loop. Sends AUTOMATICALLY – there is no "Send now" button any more:
 *  - the moment the connectivity check sees the server again (offline → online),
 *  - when the app comes back to the screen, right after something is queued,
 *  - and on a timer (every 5 s while something is waiting, backing off to 60 s when idle).
 */
export function startSyncScheduler() {
  const kick = () => {
    idleRounds = 0;
    void makeAllDue().then(() => syncNow('event'));
  };
  window.addEventListener('online', kick);
  onReachChange((r) => {
    if (r === 'online') kick();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') kick();
  });
  const loop = async () => {
    const r = await syncNow('timer').catch(() => null);
    idleRounds = r && r.received > 0 ? 0 : idleRounds + 1;
    const waiting = (await db.outbox.filter((x) => x.status !== 'received').count().catch(() => 0)) > 0;
    timer = setTimeout(loop, waiting ? 5000 : backoffMs(Math.min(idleRounds, 6), Math.random(), 5000, 60_000));
  };
  if (!timer) timer = setTimeout(loop, 1000);
  kick();
}

/* ------------------- "your SOS reached the server" notice ------------------- */

/**
 * When an SOS that could NOT be delivered straight away (the phone was offline) is finally
 * confirmed by the server, tell the person with a system notification – they may have left the
 * app. Runs in the page and in the service worker (Background Sync). Each SOS is announced once.
 */
/** An SOS confirmed later than this after it was pressed counts as "could not be sent at once". */
export const DELAYED_MS = 10_000;

export async function notifyDelivered(): Promise<void> {
  const { kvGet, kvSet } = await import('./db.ts');
  const done = new Set((await kvGet<string[]>('notifiedSos')) ?? []);
  const rows = await db.outbox.where('kind').equals('sos').toArray();
  const fresh = rows.filter((r) => r.status === 'received' && r.ack && !done.has(r.id));
  if (!fresh.length) return;
  for (const r of fresh) {
    done.add(r.id);
    const delayed = Date.parse(r.ack!.receivedAt) - Date.parse(r.createdAt) > DELAYED_MS;
    if (!delayed) continue; // sent at once – the screen already shows it
    await showNotice('✅ Your SOS reached the control room', `Reference ${r.ack!.serverId}. Rescuers can now see your location and details.`, r.id);
  }
  await kvSet('notifiedSos', [...done].slice(-200));
}

async function showNotice(title: string, body: string, tag: string) {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const reg =
      typeof (globalThis as { registration?: ServiceWorkerRegistration }).registration !== 'undefined'
        ? (globalThis as unknown as { registration: ServiceWorkerRegistration }).registration
        : await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification(title, { body, tag, icon: '/icons/sos-192.png', badge: '/icons/icon-192.png' });
    else new Notification(title, { body, tag });
  } catch {
    /* notifications unavailable – the in-app message below the SOS button still shows it */
  }
}
