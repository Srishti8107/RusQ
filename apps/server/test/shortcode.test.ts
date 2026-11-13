/** Rescuer short codes on the server: typed/pasted codes, SMS gateway, relay envelopes, replacement by the full report. */
import { beforeEach, describe, expect, it } from 'vitest';
import { encodeShortCode, formatShortCode, importTeamKey, MeshNode, parseShortCode, shortCodeId, type FieldReport } from '@rusq/shared';
import { buildApp } from '../src/app.ts';
import { DEMO_PASSWORD } from '../src/seed.ts';

type App = Awaited<ReturnType<typeof buildApp>>;
let ctx: App;
let teamKey: CryptoKey;
const tok: Record<string, string> = {};
let n = 0;
const uid = () => `01900000-0000-7000-8000-${(++n).toString(16).padStart(12, '0')}`;

async function login(u: string) {
  const r = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: DEMO_PASSWORD } });
  tok[u] = r.json().token;
}
const post = (u: string | null, url: string, payload: unknown, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url, payload: payload as object, headers: { ...(u ? { authorization: `Bearer ${tok[u]}` } : {}), ...headers } });

function report(over: Partial<FieldReport> = {}): FieldReport {
  return {
    id: uid(),
    teamId: 'team-alpha',
    lat: 27.6941,
    lng: 85.3212,
    locationSource: 'live',
    victimCount: 40,
    urgency: 4,
    notes: 'full report with notes',
    photos: [],
    requested: { food_water: 20, boats: 2 },
    aiSuggestion: null,
    humanFinal: { hazards: ['flooded street'], victimCount: 40, urgency: 4, requested: { food_water: 20, boats: 2 } },
    createdAt: new Date().toISOString(),
    ...over,
  };
}

const reports = async () => (await ctx.app.inject({ method: 'GET', url: '/api/admin/reports', headers: { authorization: `Bearer ${tok.admin}` } })).json() as (FieldReport & { serverId: string; via: string; relayHops: number | null; relayGateway: string | null; shortCodeAt: string | null })[];

beforeEach(async () => {
  ctx = await buildApp({ seed: true, testUsers: true, rateLimitMax: 100000, loginRateLimitMax: 1000, smsSecret: 'sms-test-secret' });
  for (const u of ['asha', 'ravi', 'meena', 'admin']) await login(u);
  const k = await ctx.app.inject({ method: 'GET', url: '/api/setup/keys', headers: { authorization: `Bearer ${tok.ravi}` } });
  teamKey = await importTeamKey(k.json().teamKey);
});

describe('short codes', () => {
  it('a pasted code becomes a report the control room sees; copies are duplicates', async () => {
    const before = (await reports()).length;
    const r = report();
    const code = await encodeShortCode(r, teamKey, 2);
    const res = await post('meena', '/api/codes', { text: `Fwd: ${code}` });
    expect(res.statusCode).toBe(200);
    const [first] = res.json().results;
    expect(first).toMatchObject({ ok: true, duplicate: false });
    expect(first.ack.clientId).toBe(await shortCodeId('team-alpha', parseShortCode(code).ref));

    const list = await reports();
    expect(list.length).toBe(before + 1);
    const row = list.find((x) => x.serverId === first.ack.serverId)!;
    expect(row).toMatchObject({ via: 'code', relayHops: 2, relayGateway: 'meena', victimCount: 40, urgency: 4, requested: { food_water: 20, boats: 2 } });
    expect(row.humanFinal.hazards).toEqual(['flooded street']);

    const again = (await post('ravi', '/api/codes', { text: formatShortCode(parseShortCode(code), 5) })).json().results[0];
    expect(again).toMatchObject({ ok: true, duplicate: true });
    expect(again.ack.serverId).toBe(first.ack.serverId);
    expect((await reports()).length).toBe(before + 1);
  });

  it('the full report replaces its short code (same RPT number, notes and exact location kept)', async () => {
    const r = report();
    const first = (await post('meena', '/api/codes', { text: await encodeShortCode(r, teamKey) })).json().results[0];
    const before = (await reports()).length;
    const sync = await post('ravi', '/api/sync', { items: [{ kind: 'report', data: r }] });
    expect(sync.json().acks[0]).toMatchObject({ clientId: r.id, serverId: first.ack.serverId, duplicate: false });
    const list = await reports();
    expect(list.length).toBe(before);
    const row = list.find((x) => x.serverId === first.ack.serverId)!;
    expect(row).toMatchObject({ id: r.id, via: 'direct', notes: 'full report with notes', lat: r.lat, lng: r.lng });
    expect(row.shortCodeAt).not.toBeNull();
    // A code arriving after the full report is a duplicate.
    expect((await post('meena', '/api/codes', { text: await encodeShortCode(r, teamKey) })).json().results[0]).toMatchObject({ ok: true, duplicate: true });
  });

  it('rejects tampered codes, wrong keys, victims and broken text', async () => {
    const code = await encodeShortCode(report(), teamKey);
    const bad = (await post('ravi', '/api/codes', { text: code.replace('P40', 'P99') })).json().results[0];
    expect(bad).toMatchObject({ ok: false });
    expect(bad.reason).toMatch(/signature/);
    const other = await importTeamKey(Buffer.alloc(32, 7).toString('base64'));
    expect((await post('ravi', '/api/codes', { text: await encodeShortCode(report(), other) })).json().results[0].ok).toBe(false);
    expect((await post('ravi', '/api/codes', { text: 'hello' })).json().results[0].reason).toMatch(/RQ1/);
    expect((await post('asha', '/api/codes', { text: code })).statusCode).toBe(403);
    expect((await post(null, '/api/codes', { text: code })).statusCode).toBe(401);
  });

  it('SMS gateway: needs the secret; accepts several codes in one SMS', async () => {
    const a = await encodeShortCode(report(), teamKey);
    const b = await encodeShortCode(report({ teamId: 'team-bravo' }), teamKey, 1);
    expect((await post(null, '/api/sms/inbound', { from: '+910000000001', text: a })).statusCode).toBe(401);
    const ok = await post(null, '/api/sms/inbound', { from: '+910000000001', message: `${a}\n${b}` }, { 'x-rusq-sms-secret': 'sms-test-secret' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().results.map((x: { ok: boolean }) => x.ok)).toEqual([true, true]);
    const row = (await reports()).find((x) => x.teamId === 'team-bravo' && x.via === 'code')!;
    expect(row.relayGateway).toBe('SMS gateway (from +910000000001)');
    expect(row.relayHops).toBe(1);
  });

  it('SMS gateway is off without a secret', async () => {
    const off = await buildApp({ seed: false, rateLimitMax: 100000 });
    const r = await off.app.inject({ method: 'POST', url: '/api/sms/inbound', payload: { text: 'RQ1' } });
    expect(r.statusCode).toBe(404);
  });

  it('a code relayed between phones (code envelope) is uploaded by a gateway phone; hops add up', async () => {
    const code = await encodeShortCode(report(), teamKey, 1); // came by SMS once
    const c = parseShortCode(code);
    const id = await shortCodeId(c.teamId, c.ref);
    const mk = (nodeId: string) => new MeshNode({ nodeId, teamKey, now: () => Date.now(), newId: uid });
    const a = mk('phone-a');
    const b = mk('phone-b');
    await a.originate('code', { text: code }, { id });
    const m = a.held()[0]!;
    expect((await b.receive(m)).status).toBe('accepted');
    const up = await post('meena', '/api/mesh/upload', { envelopes: b.pendingUploads() });
    expect(up.json().rejected).toEqual([]);
    expect(up.json().acks[0].clientId).toBe(id);
    const row = (await reports()).find((x) => x.id === id)!;
    expect(row).toMatchObject({ via: 'code', relayHops: 2, relayGateway: 'meena' });

    // An envelope whose id does not match its code is rejected.
    await a.originate('code', { text: await encodeShortCode(report(), teamKey) }, { id: uid() });
    const wrong = a.held().find((x) => x.id !== id)!;
    expect((await post('meena', '/api/mesh/upload', { envelopes: [wrong] })).json().rejected[0].reason).toMatch(/does not match/);
  });
});
