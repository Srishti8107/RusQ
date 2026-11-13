/**
 * §2.1 honesty rule: nothing reaches `received` without a VERIFIED server ack
 * carrying a server-side id. Gate 1 exit criterion 2 (shared-logic half; the
 * UI half is covered by the Playwright E2E test).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  applyDeliveryEvent,
  backoffMs,
  deliveryLabel,
  isDelivered,
  newDeliveryState,
  verifyAck,
  type DeliveryEvent,
  type DeliveryState,
} from '../src/index.ts';
import { keys, serverAck } from './helpers.ts';

const ID = '01890000-0000-7000-8000-0000000000aa';

describe('delivery state machine', () => {
  it('starts queued and labels say NOT sent', () => {
    const s = newDeliveryState(ID, 'sos');
    expect(s.status).toBe('queued');
    expect(isDelivered(s)).toBe(false);
    expect(deliveryLabel(s).long).toMatch(/NOT sent/);
  });

  it('queued → sent → received only with verified ack', async () => {
    const ack = await serverAck(ID, 'sos');
    let s = newDeliveryState(ID, 'sos');
    s = applyDeliveryEvent(s, { type: 'send_started', via: 'direct' });
    expect(s.status).toBe('sent');
    expect(deliveryLabel(s).short).not.toMatch(/Received|Delivered/);
    s = applyDeliveryEvent(s, { type: 'ack', ack, signatureVerified: false });
    expect(s.status).toBe('sent');
    s = applyDeliveryEvent(s, { type: 'ack', ack, signatureVerified: true });
    expect(s.status).toBe('received');
    expect(isDelivered(s)).toBe(true);
    expect(deliveryLabel(s).long).toContain(ack.serverId);
  });

  it('rejects acks for another id, another kind, or without serverId', async () => {
    const other = await serverAck('01890000-0000-7000-8000-0000000000bb', 'sos');
    const wrongKind = await serverAck(ID, 'report');
    const noServerId = { ...(await serverAck(ID, 'sos')), serverId: '' };
    let s = applyDeliveryEvent(newDeliveryState(ID, 'sos'), { type: 'send_started', via: 'direct' });
    for (const ack of [other, wrongKind, noServerId]) {
      s = applyDeliveryEvent(s, { type: 'ack', ack, signatureVerified: true });
      expect(s.status).toBe('sent');
    }
  });

  it('send failure goes back to queued with a retry time', () => {
    let s = applyDeliveryEvent(newDeliveryState(ID, 'report'), { type: 'send_started', via: 'direct' });
    s = applyDeliveryEvent(s, { type: 'send_failed', error: 'offline', nextAttemptAt: 123 });
    expect(s).toMatchObject({ status: 'queued', nextAttemptAt: 123, attempts: 1 });
  });

  it('ack signature from a rogue key does not verify', async () => {
    const k = await keys();
    const forged = await serverAck(ID, 'sos', k.rogueServerPriv);
    expect(await verifyAck(k.serverPub, forged)).toBe(false);
    expect(await verifyAck(k.serverPub, await serverAck(ID, 'sos'))).toBe(true);
    const tampered = { ...(await serverAck(ID, 'sos')), serverId: 'srv-evil' };
    expect(await verifyAck(k.serverPub, tampered)).toBe(false);
  });

  it('PROPERTY: no event sequence reaches received without a verified matching ack', async () => {
    const goodAck = await serverAck(ID, 'sos');
    const badAcks = [
      { ack: goodAck, signatureVerified: false },
      { ack: await serverAck('01890000-0000-7000-8000-0000000000cc', 'sos'), signatureVerified: true },
      { ack: { ...goodAck, serverId: '' }, signatureVerified: true },
      { ack: await serverAck(ID, 'photo'), signatureVerified: true },
    ];
    const ev = fc.oneof(
      fc.constant<DeliveryEvent>({ type: 'send_started', via: 'direct' }),
      fc.constant<DeliveryEvent>({ type: 'send_started', via: 'relay' }),
      fc.constant<DeliveryEvent>({ type: 'send_failed', error: 'x', nextAttemptAt: 5 }),
      fc.constantFrom(...badAcks).map((b): DeliveryEvent => ({ type: 'ack', ...b })),
    );
    fc.assert(
      fc.property(fc.array(ev, { maxLength: 40 }), (events) => {
        let s: DeliveryState = newDeliveryState(ID, 'sos');
        for (const e of events) s = applyDeliveryEvent(s, e);
        return s.status !== 'received' && !isDelivered(s) && !/Received|Delivered/.test(deliveryLabel(s).short);
      }),
    );
  });

  it('backoff grows exponentially, is jittered and capped', () => {
    expect(backoffMs(0, 0)).toBe(1000);
    expect(backoffMs(0, 0.999)).toBeLessThanOrEqual(2000);
    expect(backoffMs(3, 1)).toBe(16000);
    expect(backoffMs(50, 1)).toBe(300000);
    fc.assert(fc.property(fc.nat(100), fc.double({ min: 0, max: 0.9999, noNaN: true }), (a, r) => {
      const v = backoffMs(a, r);
      return v >= 1000 && v <= 300000;
    }));
  });
});
