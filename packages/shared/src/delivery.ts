/**
 * Delivery status state machine (§2.1 honesty rule).
 *
 *   queued  (stored on this device only)
 *     │ send_started
 *     ▼
 *   sent    (request in flight / handed to a relay; awaiting ack)
 *     │ ack (VERIFIED server signature, matching id, server-side id present)
 *     ▼
 *   received (acknowledged by the server)
 *
 * A failed send drops back to `queued`. There is NO other path to `received`:
 * `applyDeliveryEvent` is the only function that sets it, and it refuses
 * unverified or mismatched acks. Tests assert this exhaustively.
 */
import type { Ack, DeliveryStatus } from './schemas.ts';

export type OutboxKind = 'sos' | 'report' | 'allotment' | 'photo';

export interface DeliveryState {
  id: string;
  kind: OutboxKind;
  status: DeliveryStatus;
  attempts: number;
  /** epoch ms – earliest time the sync engine may retry */
  nextAttemptAt: number;
  lastError?: string;
  ack?: Ack;
  /** how the item left the device the last time: direct upload or via relay */
  via?: 'direct' | 'relay';
}

export type DeliveryEvent =
  | { type: 'send_started'; via: 'direct' | 'relay' }
  | { type: 'send_failed'; error: string; nextAttemptAt: number }
  | { type: 'ack'; ack: Ack; signatureVerified: boolean };

export function newDeliveryState(id: string, kind: OutboxKind): DeliveryState {
  return { id, kind, status: 'queued', attempts: 0, nextAttemptAt: 0 };
}

export function applyDeliveryEvent(s: DeliveryState, e: DeliveryEvent): DeliveryState {
  if (s.status === 'received') return s; // terminal
  switch (e.type) {
    case 'send_started':
      return { ...s, status: 'sent', attempts: s.attempts + 1, via: e.via };
    case 'send_failed':
      return { ...s, status: 'queued', lastError: e.error, nextAttemptAt: e.nextAttemptAt };
    case 'ack': {
      if (!e.signatureVerified) return s;
      if (e.ack.clientId !== s.id) return s;
      if (!e.ack.serverId) return s;
      if (e.ack.kind !== s.kind) return s;
      return { ...s, status: 'received', ack: e.ack, lastError: undefined };
    }
  }
}

/** True only for server-acknowledged items. The UI uses this for any "Delivered" wording. */
export function isDelivered(s: Pick<DeliveryState, 'status' | 'ack'>): boolean {
  return s.status === 'received' && !!s.ack?.serverId;
}

/** Plain-language labels. Note the queued text says explicitly that nothing was sent. */
export function deliveryLabel(s: Pick<DeliveryState, 'status' | 'ack' | 'via'>): { short: string; long: string } {
  if (isDelivered(s)) {
    return { short: 'Received by server', long: `Received by the control room (ref ${s.ack!.serverId}).` };
  }
  if (s.status === 'sent') {
    return {
      short: 'Sent – waiting for reply',
      long:
        s.via === 'relay'
          ? 'Passed to a nearby phone. Not confirmed yet – the control room has not replied.'
          : 'Sending. Not confirmed yet – the control room has not replied.',
    };
  }
  return { short: 'Saved on this phone only', long: 'Saved on this phone only. NOT sent yet. It will send automatically when there is a connection.' };
}

/**
 * Exponential backoff with jitter. `rand` in [0,1) is injected for testability.
 * attempt 0 → ~2 s, then 4, 8 … capped at 5 min; jitter spreads 50–100 %.
 */
export function backoffMs(attempt: number, rand: number, baseMs = 2000, capMs = 300_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.min(attempt, 20));
  return Math.round(exp * (0.5 + rand * 0.5));
}
