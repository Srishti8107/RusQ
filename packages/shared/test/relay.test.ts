/** Relay protocol unit tests (§9): envelope validation, TTL/hop expiry, duplicate suppression, chunk reassembly, signature rejection. */
import { describe, expect, it } from 'vitest';
import {
  decodeHlc,
  encodeHlc,
  HybridLogicalClock,
  Reassembler,
  sendOrder,
  signEnvelope,
  splitPhoto,
  validateEnvelope,
  type MeshMessage,
} from '../src/index.ts';
import { keys, makeNode, sampleReport, sampleSos, serverAck } from './helpers.ts';

const SOS_ID = '01890000-0000-7000-8000-000000000101';
const REP_ID = '01890000-0000-7000-8000-000000000102';

describe('envelope validation', () => {
  it('accepts a well-formed signed SOS envelope', async () => {
    const a = await makeNode('A');
    const m = await a.originate('sos', sampleSos(SOS_ID));
    expect(validateEnvelope(m).ok).toBe(true);
    expect(m.priority).toBe(0);
    expect(m.id).toBe(SOS_ID);
  });

  it('rejects malformed envelopes', async () => {
    const a = await makeNode('A');
    const good = await a.originate('sos', sampleSos(SOS_ID));
    const cases: [string, unknown][] = [
      ['not an object', 'hello'],
      ['missing mac', { ...good, mac: undefined }],
      ['bad type', { ...good, type: 'spam' }],
      ['bad hlc', { ...good, createdAt: 'yesterday' }],
      ['bad payload', { ...good, payload: { id: SOS_ID } }],
      ['id mismatch', { ...good, id: '01890000-0000-7000-8000-000000000999' }],
      ['hops > ttl', { ...good, hops: 10, ttl: 5 }],
      ['chunk info on sos', { ...good, chunkInfo: { photoId: SOS_ID, reportId: REP_ID, index: 0, total: 1, totalBytes: 1, sha256: 'a'.repeat(64) } }],
      ['wrong version', { ...good, v: 2 }],
    ];
    for (const [name, raw] of cases) {
      expect(validateEnvelope(raw).ok, name).toBe(false);
    }
  });
});

describe('integrity', () => {
  it('rejects messages signed with another team key', async () => {
    const k = await keys();
    const outsider = await makeNode('X', { teamKey: k.otherTeamKey });
    const b = await makeNode('B');
    const m = await outsider.originate('sos', sampleSos(SOS_ID));
    expect(await b.receive(m)).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/MAC/) });
    expect(b.has(SOS_ID)).toBe(false);
  });

  it('rejects tampered payloads', async () => {
    const a = await makeNode('A');
    const b = await makeNode('B');
    const m = await a.originate('sos', sampleSos(SOS_ID));
    const tampered = { ...m, payload: { ...(m.payload as object), lat: 0 } };
    expect((await b.receive(tampered)).status).toBe('rejected');
  });

  it('a changed hop count does not invalidate the MAC (hops is mutable by design)', async () => {
    const a = await makeNode('A');
    const b = await makeNode('B');
    const m = await a.originate('sos', sampleSos(SOS_ID));
    expect((await b.receive({ ...m, hops: 3 })).status).toBe('accepted');
  });

  it('rejects ack envelopes whose server signature is forged, even with a valid team MAC', async () => {
    const k = await keys();
    const a = await makeNode('A');
    const b = await makeNode('B');
    const forged = await serverAck(SOS_ID, 'sos', k.rogueServerPriv);
    const env = await signEnvelope(k.teamKey, {
      v: 1,
      id: '01890000-0000-7000-8000-000000000555',
      type: 'ack',
      originNodeId: 'A',
      createdAt: encodeHlc(a.clock.tick()),
      hops: 0,
      ttl: 64,
      priority: 0,
      payload: forged,
    });
    expect(await b.receive(env)).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/server signature/) });
    expect(b.isAcked(SOS_ID)).toBe(false);
  });
});

describe('TTL / hops', () => {
  it('rejects a message that already used its hop budget', async () => {
    const a = await makeNode('A');
    const b = await makeNode('B');
    const m = await a.originate('sos', sampleSos(SOS_ID), { ttl: 2 });
    expect((await b.receive({ ...m, hops: 2 })).status).toBe('rejected');
  });

  it('does not offer a held message once hops reach ttl', async () => {
    const a = await makeNode('A');
    const b = await makeNode('B');
    const c = await makeNode('C');
    const m = await a.originate('sos', sampleSos(SOS_ID), { ttl: 1 });
    expect((await b.receive(m)).status).toBe('accepted'); // b holds it with hops=1
    expect(b.messagesFor(c.summary())).toHaveLength(0);
  });

  it('increments hops on each relay', async () => {
    const a = await makeNode('A');
    const b = await makeNode('B');
    const c = await makeNode('C');
    await a.originate('sos', sampleSos(SOS_ID));
    for (const m of a.messagesFor(b.summary())) await b.receive(m);
    for (const m of b.messagesFor(c.summary())) await c.receive(m);
    expect(c.held()[0]!.hops).toBe(2);
  });
});

describe('duplicate suppression & anti-entropy', () => {
  it('accepts a message once, then reports duplicates', async () => {
    const a = await makeNode('A');
    const b = await makeNode('B');
    const m = await a.originate('sos', sampleSos(SOS_ID));
    expect((await b.receive(m)).status).toBe('accepted');
    for (let i = 0; i < 5; i++) expect((await b.receive(m)).status).toBe('duplicate');
    expect(b.stats.duplicates).toBe(5);
  });

  it('only sends what the peer lacks', async () => {
    const a = await makeNode('A');
    const b = await makeNode('B');
    await a.originate('sos', sampleSos(SOS_ID));
    await a.originate('report', sampleReport(REP_ID));
    for (const m of a.messagesFor(b.summary())) await b.receive(m);
    expect(a.messagesFor(b.summary())).toHaveLength(0);
    expect(b.messagesFor(a.summary())).toHaveLength(0);
  });

  it('sends SOS before reports before photo chunks', async () => {
    const a = await makeNode('A');
    const bytes = new Uint8Array(40_000).map((_, i) => i % 251);
    for (const c of await splitPhoto(bytes, '01890000-0000-7000-8000-000000000301', REP_ID)) {
      await a.originate('photo_chunk', { data: c.data, mime: 'image/jpeg' }, { chunkInfo: c.info });
    }
    await a.originate('report', sampleReport(REP_ID));
    await a.originate('sos', sampleSos(SOS_ID));
    const b = await makeNode('B');
    const order = a.messagesFor(b.summary()).map((m) => m.type);
    expect(order[0]).toBe('sos');
    expect(order[1]).toBe('report');
    expect(order.slice(2).every((t) => t === 'photo_chunk')).toBe(true);
  });

  it('a verified ack stops forwarding and propagates', async () => {
    const a = await makeNode('A');
    const gw = await makeNode('G');
    const c = await makeNode('C');
    await a.originate('sos', sampleSos(SOS_ID));
    for (const m of a.messagesFor(gw.summary())) await gw.receive(m);
    expect(gw.pendingUploads()).toHaveLength(1);
    expect(await gw.ingestServerAcks([await serverAck(SOS_ID, 'sos')])).toBe(1);
    expect(gw.pendingUploads()).toHaveLength(0);
    // ack flows back to A, A stops holding the SOS
    for (const m of gw.messagesFor(a.summary())) await a.receive(m);
    expect(a.isAcked(SOS_ID)).toBe(true);
    expect(a.held().filter((m) => m.type === 'sos')).toHaveLength(0);
    // C (never saw the SOS) gets the ack only, not the SOS
    for (const m of gw.messagesFor(c.summary())) await c.receive(m);
    expect(c.held().map((m) => m.type)).toEqual(['ack']);
  });

  it('gateway ignores acks with forged server signature', async () => {
    const k = await keys();
    const gw = await makeNode('G');
    await gw.originate('sos', sampleSos(SOS_ID));
    expect(await gw.ingestServerAcks([await serverAck(SOS_ID, 'sos', k.rogueServerPriv)])).toBe(0);
    expect(gw.isAcked(SOS_ID)).toBe(false);
  });
});

describe('photo chunks', () => {
  const PHOTO = '01890000-0000-7000-8000-000000000401';
  it('reassembles out-of-order chunks and verifies sha256', async () => {
    const bytes = new Uint8Array(50_000).map((_, i) => (i * 7) % 256);
    const chunks = await splitPhoto(bytes, PHOTO, REP_ID, 16 * 1024);
    expect(chunks).toHaveLength(4);
    const r = new Reassembler();
    const order = [3, 1, 0, 2];
    let last;
    for (const i of order) last = await r.add({ chunkInfo: chunks[i]!.info, payload: { data: chunks[i]!.data } });
    expect(last!.state).toBe('complete');
    if (last!.state === 'complete') expect(last!.bytes).toEqual(bytes);
  });

  it('reports incomplete progress and detects corruption', async () => {
    const bytes = new Uint8Array(20_000).fill(9);
    const chunks = await splitPhoto(bytes, PHOTO, REP_ID, 16 * 1024);
    const r = new Reassembler();
    expect((await r.add({ chunkInfo: chunks[0]!.info, payload: { data: chunks[0]!.data } })).state).toBe('incomplete');
    const bad = await r.add({ chunkInfo: chunks[1]!.info, payload: { data: btoa('xxxx') } });
    expect(bad.state).toBe('corrupt');
  });

  it('rejects metadata mismatch between chunks', async () => {
    const a = await splitPhoto(new Uint8Array(20_000).fill(1), PHOTO, REP_ID);
    const b = await splitPhoto(new Uint8Array(30_000).fill(2), PHOTO, REP_ID);
    const r = new Reassembler();
    await r.add({ chunkInfo: a[0]!.info, payload: { data: a[0]!.data } });
    expect((await r.add({ chunkInfo: b[1]!.info, payload: { data: b[1]!.data } })).state).toBe('corrupt');
  });
});

describe('hybrid logical clock', () => {
  it('is monotonic even if the wall clock goes backwards', () => {
    let t = 1000;
    const c = new HybridLogicalClock('a', () => t);
    const s1 = encodeHlc(c.tick());
    t = 500;
    const s2 = encodeHlc(c.tick());
    expect(s2 > s1).toBe(true);
  });

  it('receive() orders after the remote event despite skew', () => {
    const slow = new HybridLogicalClock('slow', () => 1000);
    const fast = new HybridLogicalClock('fast', () => 9000);
    const sent = fast.tick();
    const got = slow.receive(sent);
    expect(encodeHlc(got) > encodeHlc(sent)).toBe(true);
    expect(decodeHlc(encodeHlc(got))).toEqual(got);
  });

  it('ignores absurdly-far-future clocks but still ticks', () => {
    const c = new HybridLogicalClock('a', () => 1000, 10_000);
    const r = c.receive({ l: 10_000_000, c: 0, n: 'evil' });
    expect(r.l).toBe(1000);
    expect(c.driftRejections).toBe(1);
  });

  it('sendOrder is a total order', async () => {
    const a = await makeNode('A');
    const ms: MeshMessage[] = [];
    for (let i = 0; i < 5; i++) {
      ms.push(await a.originate('sos', sampleSos(`01890000-0000-7000-8000-00000000060${i}`)));
    }
    const sorted = [...ms].reverse().sort(sendOrder);
    expect(sorted.map((m) => m.id)).toEqual(ms.map((m) => m.id));
  });
});
