import { describe, expect, it } from 'vitest';
import {
  encodeShortCode,
  extractShortCodes,
  formatShortCode,
  geohashDecode,
  geohashEncode,
  parseShortCode,
  shortCodeId,
  shortCodeToReport,
  shortRef,
  SMS_MAX_CHARS,
  validateEnvelope,
  verifyShortCode,
  FieldReport,
  RESOURCE_KEYS,
  type ResourceQty,
} from '../src/index.ts';
import { keys } from './helpers.ts';

const base = {
  id: '01890a5d-ac96-774b-bcce-b302099a8057',
  teamId: 'team-alpha',
  lat: 27.70412,
  lng: 85.31946,
  createdAt: '2026-11-13T09:41:27.000Z',
  humanFinal: {
    hazards: ['flooded street', 'people waiting for rescue'] as FieldReport['humanFinal']['hazards'],
    victimCount: 40,
    urgency: 4,
    requested: { food_water: 20, first_aid_kits: 3, boats: 2 } as ResourceQty,
  },
};

describe('rescuer short code', () => {
  it('round-trips every field and fits one SMS', async () => {
    const { teamKey } = await keys();
    const code = await encodeShortCode(base, teamKey);
    expect(code).toMatch(/^RQ1 Tteam-alpha G\w{8} P40 U4 NF20A3B2 Z\w\w D\w{5} R\w{6} H0 X\w{8}$/);
    expect(code.length).toBeLessThanOrEqual(SMS_MAX_CHARS);
    const c = parseShortCode(code);
    expect(c).toMatchObject({ teamId: 'team-alpha', people: 40, urgency: 4, hops: 0, requested: base.humanFinal.requested, hazards: base.humanFinal.hazards });
    expect(c.createdAt).toBe('2026-11-13T09:41:00.000Z');
    expect(Math.abs(c.lat - base.lat)).toBeLessThan(0.0003);
    expect(Math.abs(c.lng - base.lng)).toBeLessThan(0.0003);
    expect(c.ref).toBe(await shortRef(base.id));
    expect(await verifyShortCode(c, teamKey)).toBe(true);
  });

  it('worst case (every resource at its maximum, long team id) still fits one SMS', async () => {
    const { teamKey } = await keys();
    const requested = Object.fromEntries(RESOURCE_KEYS.map((k) => [k, 1_000_000])) as ResourceQty;
    const code = await encodeShortCode({ ...base, teamId: 'a'.repeat(24), humanFinal: { ...base.humanFinal, victimCount: 100_000, requested } }, teamKey);
    expect(code.length).toBeLessThanOrEqual(SMS_MAX_CHARS);
    expect(parseShortCode(code).requested).toEqual(requested);
  });

  it('a report with no needs and no hazards is still valid', async () => {
    const { teamKey } = await keys();
    const code = await encodeShortCode({ ...base, humanFinal: { ...base.humanFinal, hazards: [], requested: {} } }, teamKey);
    expect(code).not.toMatch(/ N| Z/);
    const c = parseShortCode(code);
    expect(c.requested).toEqual({});
    expect(await verifyShortCode(c, teamKey)).toBe(true);
  });

  it('changing the hop count keeps the signature; changing anything else breaks it', async () => {
    const { teamKey } = await keys();
    const code = await encodeShortCode(base, teamKey);
    const hopped = formatShortCode(parseShortCode(code), 3);
    expect(parseShortCode(hopped).hops).toBe(3);
    expect(await verifyShortCode(parseShortCode(hopped), teamKey)).toBe(true);
    for (const tampered of [code.replace('P40', 'P400'), code.replace('F20', 'F90'), code.replace('U4', 'U5'), code.replace('Tteam-alpha', 'Tteam-bravo')]) {
      expect(await verifyShortCode(parseShortCode(tampered), teamKey)).toBe(false);
    }
  });

  it('another team key does not verify', async () => {
    const { teamKey, otherTeamKey } = await keys();
    const c = parseShortCode(await encodeShortCode(base, teamKey));
    expect(await verifyShortCode(c, otherTeamKey)).toBe(false);
  });

  it('is case-insensitive (except the team) and tolerant of extra spaces and O/0, I/1 mix-ups', async () => {
    const { teamKey } = await keys();
    const code = await encodeShortCode(base, teamKey);
    const messy = code
      .split(' ')
      .map((t, i) => (i === 1 ? t : t.toLowerCase()))
      .join('   ')
      .replace(/x(\w{8})$/, (_m, mac: string) => `x${mac.replace(/0/g, 'o').replace(/1/g, 'i')}`);
    expect(await verifyShortCode(parseShortCode(messy), teamKey)).toBe(true);
  });

  it('finds codes inside a longer SMS', async () => {
    const { teamKey } = await keys();
    const a = await encodeShortCode(base, teamKey);
    const b = await encodeShortCode({ ...base, id: '01890a5d-ac96-774b-bcce-b302099a8058' }, teamKey);
    expect(extractShortCodes(`Fwd from Ravi: ${a}\nand also\n${b} thanks`)).toEqual([a, b]);
  });

  it('rejects broken codes with a plain reason', () => {
    expect(() => parseShortCode('hello')).toThrow(/RQ1/);
    expect(() => parseShortCode('RQ1 Tteam-alpha P40 U4 D00000 R000000 H0 X00000000')).toThrow(/part G is missing/);
    expect(() => parseShortCode('RQ1 Tteam-alpha Gtdr1y7q2 P40 U4 NQ5 D00000 R000000 H0 X00000000')).toThrow(/unknown need letter Q/);
    expect(() => parseShortCode('RQ1 Tteam-alpha Gtdr1y7q2 P40 U9 D00000 R000000 H0 X00000000')).toThrow(/U must be a number up to 5/);
    expect(() => parseShortCode('RQ1 Tteam-alpha Gtdr1y7q2 P40 U4 NF5F6 D00000 R000000 H0 X00000000')).toThrow(/twice/);
  });

  it('geohash is accurate to about 20 m', () => {
    for (const [lat, lng] of [[27.70412, 85.31946], [-33.86, 151.2], [0, 0], [89.9, -179.9]] as const) {
      const d = geohashDecode(geohashEncode(lat, lng))!;
      expect(Math.abs(d.lat - lat)).toBeLessThan(0.0002);
      expect(Math.abs(d.lng - lng)).toBeLessThan(0.0002);
    }
  });

  it('the stored report is a valid FieldReport with a stable id, and the relay accepts a code envelope', async () => {
    const { teamKey } = await keys();
    const c = parseShortCode(await encodeShortCode(base, teamKey));
    const r = await shortCodeToReport(c);
    expect(FieldReport.safeParse(r).success).toBe(true);
    expect(r.id).toBe(await shortCodeId('team-alpha', c.ref));
    expect(r.id).toBe((await shortCodeToReport(parseShortCode(formatShortCode(c, 5)))).id);
    const env = { v: 1, id: r.id, type: 'code', originNodeId: 'n1', createdAt: '000000000000001:00000:n1', hops: 0, ttl: 64, priority: 1, payload: { text: formatShortCode(c) }, mac: 'x' };
    const check = validateEnvelope(env);
    expect(check.ok ? 'ok' : check.reason).toBe('ok');
  });
});
