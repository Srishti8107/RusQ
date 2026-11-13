/** Server integration tests (§9): idempotency, ack round-trip, reconciliation conflicts, snapshot versioning, security basics. */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  allocate,
  buildAllocationInput,
  canonicalJson,
  computeProvisionalAllotment,
  importServerPublicKey,
  importTeamKey,
  MeshNode,
  mulberry32,
  seededUuid,
  splitPhoto,
  verifyAck,
  type Ack,
  type FieldReport,
  type Snapshot,
  type Sos,
} from '@rusq/shared';
import { buildApp } from '../src/app.ts';
import { DEMO_PASSWORD } from '../src/seed.ts';

type App = Awaited<ReturnType<typeof buildApp>>;
let ctx: App;
const tokens: Record<string, string> = {};
const users: Record<string, { id: string }> = {};

async function login(username: string) {
  const r = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: DEMO_PASSWORD } });
  expect(r.statusCode).toBe(200);
  tokens[username] = r.json().token;
  users[username] = r.json().user;
}

const auth = (u: string) => ({ authorization: `Bearer ${tokens[u]}` });
let n = 0;
const uid = () => `01890000-0000-7000-8000-${(++n).toString(16).padStart(12, '0')}`;

function sos(userId: string, id = uid()): Sos {
  return { id, userId, lat: 26.16, lng: 91.77, accuracy: 20, locationSource: 'live', createdAt: new Date().toISOString(), source: 'app' };
}
function report(id = uid(), over: Partial<FieldReport> = {}): FieldReport {
  return {
    id,
    teamId: 'team-alpha',
    lat: 26.17,
    lng: 91.75,
    locationSource: 'live',
    victimCount: 30,
    urgency: 5,
    notes: '',
    photos: [],
    requested: { boats: 3, food_water: 100 },
    aiSuggestion: null,
    humanFinal: { hazards: ['flooded street'], victimCount: 30, urgency: 5, requested: { boats: 3, food_water: 100 } },
    createdAt: new Date().toISOString(),
    ...over,
  };
}

beforeEach(async () => {
  ctx = await buildApp({ seed: true });
  for (const u of ['asha', 'ravi', 'meena', 'admin']) await login(u);
});

describe('idempotent upload + ack round trip', () => {
  it('same SOS id sent 5 times creates exactly one record; every ack carries the same server id', async () => {
    const s = sos(users.asha!.id);
    const acks: Ack[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await ctx.app.inject({ method: 'POST', url: '/api/sync', headers: auth('asha'), payload: { items: [{ kind: 'sos', data: s }] } });
      expect(r.statusCode).toBe(200);
      acks.push(r.json().acks[0]);
    }
    expect(ctx.services.count('sos')).toBe(1);
    expect(new Set(acks.map((a) => a.serverId)).size).toBe(1);
    expect(acks[0]!.duplicate).toBe(false);
    expect(acks.slice(1).every((a) => a.duplicate)).toBe(true);
  });

  it('ack is signed by the server key published at /api/server-key', async () => {
    const pub = await importServerPublicKey((await ctx.app.inject({ url: '/api/server-key' })).json().ackPublicJwk);
    const r = await ctx.app.inject({ method: 'POST', url: '/api/sync', headers: auth('ravi'), payload: { items: [{ kind: 'report', data: report() }] } });
    const ack = r.json().acks[0] as Ack;
    expect(ack.serverId).toMatch(/^RPT-\d{6}$/);
    expect(await verifyAck(pub, ack)).toBe(true);
    expect(await verifyAck(pub, { ...ack, serverId: 'RPT-999999' })).toBe(false);
  });

  it('same report 5 times in one batch and across batches → one record', async () => {
    const r1 = report();
    await ctx.app.inject({ method: 'POST', url: '/api/sync', headers: auth('ravi'), payload: { items: Array(5).fill({ kind: 'report', data: r1 }) } });
    for (let i = 0; i < 4; i++) await ctx.app.inject({ method: 'POST', url: '/api/sync', headers: auth('ravi'), payload: { items: [{ kind: 'report', data: r1 }] } });
    expect(ctx.services.count('reports')).toBe(1);
  });

  it('photo PUT is idempotent and rejects non-images', async () => {
    const id = uid();
    const rid = uid();
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 7)]);
    for (let i = 0; i < 5; i++) {
      const r = await ctx.app.inject({ method: 'PUT', url: `/api/photos/${id}`, headers: { ...auth('ravi'), 'content-type': 'image/jpeg', 'x-report-id': rid }, payload: jpeg });
      expect(r.statusCode).toBe(200);
    }
    expect(ctx.services.count('photos')).toBe(1);
    const bad = await ctx.app.inject({ method: 'PUT', url: `/api/photos/${uid()}`, headers: { ...auth('ravi'), 'content-type': 'image/jpeg', 'x-report-id': rid }, payload: Buffer.alloc(100, 1) });
    expect(bad.statusCode).toBe(400);
  });
});

describe('mesh gateway upload', () => {
  async function relayNode(id: string, teamKeyB64?: string) {
    const keysR = await ctx.app.inject({ url: '/api/setup/keys', headers: auth('ravi') });
    const k = keysR.json();
    return new MeshNode({
      nodeId: id,
      teamKey: await importTeamKey(teamKeyB64 ?? k.teamKey),
      serverPublicKey: await importServerPublicKey(k.ackPublicJwk),
      now: () => Date.now(),
      newId: seededUuid(mulberry32(id.length + 99)),
    });
  }

  it('accepts MAC-valid envelopes, rejects forged ones, acks are relayable', async () => {
    const phone = await relayNode('phone-a');
    const s = sos(users.asha!.id);
    const env = await phone.originate('sos', s);
    const outsider = await relayNode('outsider', btoa(String.fromCharCode(...new Uint8Array(32).fill(3))));
    const forged = await outsider.originate('report', report());
    const r = await ctx.app.inject({ method: 'POST', url: '/api/mesh/upload', headers: auth('meena'), payload: { envelopes: [env, forged] } });
    const body = r.json();
    expect(body.acks).toHaveLength(1);
    expect(body.rejected).toEqual([{ id: forged.id, reason: 'bad MAC' }]);
    // gateway wraps the server ack; the origin phone accepts it and marks the SOS received
    const gw = await relayNode('gateway');
    await gw.receive(env);
    expect(await gw.ingestServerAcks(body.acks)).toBe(1);
    for (const m of gw.messagesFor(phone.summary())) await phone.receive(m);
    expect(phone.isAcked(s.id)).toBe(true);
    expect(ctx.services.listSos()[0]!.via).toBe('relay');
  });

  it('reassembles photo chunks uploaded out of order across several uploads', async () => {
    const phone = await relayNode('phone-b');
    const bytes = new Uint8Array(60_000).map((_, i) => (i * 13) % 256);
    bytes[0] = 0xff;
    bytes[1] = 0xd8;
    const pid = uid();
    const chunks = await splitPhoto(bytes, pid, uid());
    const envs = [];
    for (const c of chunks) envs.push(await phone.originate('photo_chunk', { data: c.data, mime: 'image/jpeg' }, { chunkInfo: c.info }));
    envs.reverse();
    const first = await ctx.app.inject({ method: 'POST', url: '/api/mesh/upload', headers: auth('ravi'), payload: { envelopes: envs.slice(0, 2) } });
    expect(first.json().acks).toHaveLength(0);
    const second = await ctx.app.inject({ method: 'POST', url: '/api/mesh/upload', headers: auth('ravi'), payload: { envelopes: envs.slice(2) } });
    expect(second.json().acks.map((a: Ack) => a.kind)).toEqual(['photo']);
    const got = await ctx.app.inject({ url: `/api/photos/${pid}`, headers: auth('admin') });
    expect(new Uint8Array(got.rawPayload)).toEqual(bytes);
  });
});

describe('reconciliation', () => {
  it('two devices over-allocating boats creates a conflict; admin decisions resolve it', async () => {
    const snap = (await ctx.app.inject({ url: '/api/snapshot', headers: auth('ravi') })).json() as Snapshot;
    // Each device sees the full snapshot stock (4 boats) and claims boats for its own incident.
    const r1 = report(uid(), { requested: { boats: 3 }, victimCount: 40, urgency: 5 });
    const r2 = report(uid(), { requested: { boats: 3 }, victimCount: 35, urgency: 5 });
    const a1 = computeProvisionalAllotment({ snapshot: snap, report: r1, deviceId: 'phone-ravi', id: uid(), createdAt: new Date().toISOString() }).allotment;
    const a2 = computeProvisionalAllotment({ snapshot: snap, report: r2, deviceId: 'phone-meena', id: uid(), createdAt: new Date().toISOString() }).allotment;
    // Neither device knows about the other's claim → together they claim more than the 4 boats in stock.
    expect((a1.claim.boats ?? 0) + (a2.claim.boats ?? 0)).toBeGreaterThan(4);
    await ctx.app.inject({ method: 'POST', url: '/api/sync', headers: auth('ravi'), payload: { items: [{ kind: 'allotment', data: a1 }] } });
    await ctx.app.inject({ method: 'POST', url: '/api/sync', headers: auth('meena'), payload: { items: [{ kind: 'allotment', data: a2 }] } });

    // Force the conflict to be about real over-claim: live stock is only 4 boats.
    const rec = (await ctx.app.inject({ url: '/api/admin/reconciliation', headers: auth('admin') })).json();
    const claimed = (a1.claim.boats ?? 0) + (a2.claim.boats ?? 0);
    expect(rec.pendingTotals.boats).toBe(claimed);
    if (claimed > 4) {
      const c = rec.conflicts.find((x: { resource: string }) => x.resource === 'boats');
      expect(c).toMatchObject({ status: 'open', liveStock: 4, claimed, devices: ['phone-meena', 'phone-ravi'] });
    }

    // Lower live stock so a conflict is guaranteed regardless of engine shares.
    await ctx.app.inject({ method: 'PUT', url: '/api/admin/stock', headers: auth('admin'), payload: { boats: 1 } });
    const rec2 = (await ctx.app.inject({ url: '/api/admin/reconciliation', headers: auth('admin') })).json();
    const conflict = rec2.conflicts.find((x: { resource: string; status: string }) => x.resource === 'boats' && x.status === 'open');
    expect(conflict).toBeTruthy();
    // Device values are NOT overwritten
    expect(rec2.allotments.find((x: { id: string }) => x.id === a1.id).claim).toEqual(a1.claim);

    // Admin rejects one, approves the other with a reduced claim → conflict resolved, stock deducted
    let r = await ctx.app.inject({ method: 'POST', url: `/api/admin/allotments/${a2.id}/decision`, headers: auth('admin'), payload: { decision: 'reject', note: 'covered by Alpha' } });
    expect(r.statusCode).toBe(200);
    r = await ctx.app.inject({ method: 'POST', url: `/api/admin/allotments/${a1.id}/decision`, headers: auth('admin'), payload: { decision: 'approve', approvedClaim: { boats: 1 } } });
    expect(r.statusCode).toBe(200);
    const rec3 = (await ctx.app.inject({ url: '/api/admin/reconciliation', headers: auth('admin') })).json();
    expect(rec3.liveStock.boats).toBe(0);
    expect(rec3.conflicts.filter((x: { status: string }) => x.status === 'open')).toHaveLength(0);
    // decisions are final
    r = await ctx.app.inject({ method: 'POST', url: `/api/admin/allotments/${a1.id}/decision`, headers: auth('admin'), payload: { decision: 'reject' } });
    expect(r.statusCode).toBe(409);
    // audit trail
    const audit = (await ctx.app.inject({ url: '/api/admin/audit', headers: auth('admin') })).json() as { action: string }[];
    const actions = audit.map((a) => a.action);
    for (const a of ['conflict.created', 'allotment.rejected', 'allotment.approved', 'conflict.resolved', 'stock.set']) expect(actions).toContain(a);
  });

  it('approval cannot exceed live stock or the device claim', async () => {
    const snap = (await ctx.app.inject({ url: '/api/snapshot', headers: auth('ravi') })).json() as Snapshot;
    const a = computeProvisionalAllotment({ snapshot: snap, report: report(uid(), { requested: { boats: 2 } }), deviceId: 'd1', id: uid(), createdAt: new Date().toISOString() }).allotment;
    await ctx.app.inject({ method: 'POST', url: '/api/sync', headers: auth('ravi'), payload: { items: [{ kind: 'allotment', data: a }] } });
    const tooMuch = await ctx.app.inject({ method: 'POST', url: `/api/admin/allotments/${a.id}/decision`, headers: auth('admin'), payload: { decision: 'approve', approvedClaim: { boats: 99 } } });
    expect(tooMuch.statusCode).toBe(400);
    await ctx.app.inject({ method: 'PUT', url: '/api/admin/stock', headers: auth('admin'), payload: { boats: 0 } });
    const noStock = await ctx.app.inject({ method: 'POST', url: `/api/admin/allotments/${a.id}/decision`, headers: auth('admin'), payload: { decision: 'approve' } });
    expect(noStock.statusCode).toBe(409);
  });
});

describe('snapshot versioning', () => {
  it('publishing increments the version and marks older allotments stale', async () => {
    const s1 = (await ctx.app.inject({ url: '/api/snapshot', headers: auth('ravi') })).json() as Snapshot;
    expect(s1.version).toBe(1);
    const a = computeProvisionalAllotment({ snapshot: s1, report: report(), deviceId: 'd', id: uid(), createdAt: new Date().toISOString() }).allotment;
    await ctx.app.inject({ method: 'POST', url: '/api/sync', headers: auth('ravi'), payload: { items: [{ kind: 'allotment', data: a }] } });
    await ctx.app.inject({ method: 'PUT', url: '/api/admin/stock', headers: auth('admin'), payload: { food_water: 900 } });
    const s2 = (await ctx.app.inject({ method: 'POST', url: '/api/admin/snapshot', headers: auth('admin') })).json() as Snapshot;
    expect(s2.version).toBe(2);
    expect(s2.stock.food_water).toBe(900);
    const latest = (await ctx.app.inject({ url: '/api/snapshot', headers: auth('asha') })).json() as Snapshot;
    expect(latest.version).toBe(2);
    const rec = (await ctx.app.inject({ url: '/api/admin/reconciliation', headers: auth('admin') })).json();
    expect(rec.allotments.find((x: { id: string }) => x.id === a.id).staleSnapshot).toBe(true);
  });
});

describe('allocation parity (server endpoint vs in-process)', () => {
  it('server /api/allocate output is byte-identical to the local engine', async () => {
    const snap = (await ctx.app.inject({ url: '/api/snapshot', headers: auth('ravi') })).json() as Snapshot;
    const input = buildAllocationInput(snap, report(), { provisional: true });
    const r = await ctx.app.inject({ method: 'POST', url: '/api/allocate', headers: auth('ravi'), payload: input });
    expect(r.body).toBe(JSON.stringify(allocate(input)));
    expect(canonicalJson(r.json())).toBe(canonicalJson(allocate(input)));
  });
});

describe('security basics', () => {
  it('auth required on every data endpoint', async () => {
    for (const [method, url] of [
      ['POST', '/api/sync'],
      ['POST', '/api/mesh/upload'],
      ['GET', '/api/snapshot'],
      ['GET', '/api/setup/keys'],
      ['GET', '/api/admin/reconciliation'],
      ['GET', '/api/admin/audit'],
    ] as const) {
      const r = await ctx.app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
      expect(r.statusCode, url).toBe(401);
    }
    const forged = await ctx.app.inject({ url: '/api/snapshot', headers: { authorization: 'Bearer ' + tokens.asha!.slice(0, -3) + 'abc' } });
    expect(forged.statusCode).toBe(401);
  });

  it('role-based access: victim cannot read admin data or submit reports; rescuer cannot decide allotments', async () => {
    expect((await ctx.app.inject({ url: '/api/admin/reconciliation', headers: auth('asha') })).statusCode).toBe(403);
    expect((await ctx.app.inject({ url: '/api/admin/reconciliation', headers: auth('ravi') })).statusCode).toBe(403);
    const r = await ctx.app.inject({ method: 'POST', url: `/api/admin/allotments/${uid()}/decision`, headers: auth('ravi'), payload: { decision: 'approve' } });
    expect(r.statusCode).toBe(403);
    const rep = await ctx.app.inject({ method: 'POST', url: '/api/sync', headers: auth('asha'), payload: { items: [{ kind: 'report', data: report() }] } });
    expect(rep.json().rejected[0].reason).toMatch(/victim/);
    const other = await ctx.app.inject({ method: 'POST', url: '/api/sync', headers: auth('asha'), payload: { items: [{ kind: 'sos', data: sos(users.ravi!.id) }] } });
    expect(other.json().rejected[0].reason).toMatch(/userId/);
  });

  it('schema validation rejects bad input without creating records', async () => {
    const bad = { ...report(), urgency: 9, lat: 500 };
    const r = await ctx.app.inject({ method: 'POST', url: '/api/sync', headers: auth('ravi'), payload: { items: [{ kind: 'report', data: bad }] } });
    expect(r.statusCode).toBe(200);
    expect(r.json().acks).toHaveLength(0);
    expect(r.json().rejected).toHaveLength(1);
    expect(ctx.services.count('reports')).toBe(0);
    const extraKey = await ctx.app.inject({ method: 'PUT', url: '/api/admin/stock', headers: auth('admin'), payload: { unicorns: 5 } });
    expect(extraKey.statusCode).toBe(400);
    const noItems = await ctx.app.inject({ method: 'POST', url: '/api/sync', headers: auth('ravi'), payload: { items: [] } });
    expect(noItems.statusCode).toBe(400);
  });

  it('rate limit kicks in on login', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 25; i++) {
      codes.push((await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'x', password: 'y' } })).statusCode);
    }
    expect(codes).toContain(429);
  });

  it('no secrets leak: setup keys exclude the private ack key and token secret', async () => {
    const body = (await ctx.app.inject({ url: '/api/setup/keys', headers: auth('ravi') })).body;
    expect(body).not.toMatch(/"d"\s*:/); // JWK private component
    expect(body).not.toContain(ctx.services.keys.tokenSecret.toString('base64'));
  });
});
