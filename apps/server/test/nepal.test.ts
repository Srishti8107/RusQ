/** Real Nepal background data (WorldPop 2024, terrain flood susceptibility, OSM hospitals, NDRRMA figures). */
import { beforeEach, describe, expect, it } from 'vitest';
import { decide } from '@rusq/shared';
import { buildApp } from '../src/app.ts';
import { areaContext, nearestFacility, nepalContext, REFERENCE_EVENT_2024 } from '../src/nepal/context.ts';
import { DEMO_PASSWORD } from '../src/seed.ts';

type App = Awaited<ReturnType<typeof buildApp>>;
let ctx: App;
const tok: Record<string, string> = {};

beforeEach(async () => {
  ctx = await buildApp({ seed: true, testUsers: true, rateLimitMax: 100000, loginRateLimitMax: 1000 });
  for (const u of ['asha', 'admin']) {
    const r = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: DEMO_PASSWORD } });
    tok[u] = r.json().token;
  }
});

describe('Nepal context data', () => {
  it('is plausible for the Kathmandu sample region', () => {
    const c = nepalContext();
    // WorldPop 2024 (constrained) ≈ 1.2 M in the box – the same order as Census 2021 for KMC + LMC.
    expect(c.totals.residents).toBeGreaterThan(900_000);
    expect(c.totals.residents).toBeLessThan(1_600_000);
    expect(c.totals.residentsFloodProne).toBeLessThan(c.totals.residents);
    expect(c.totals.floodProneKm2).toBeGreaterThan(1);
    expect(Object.keys(c.cells).length).toBeGreaterThan(50);
    for (const v of Object.values(c.cells)) {
      expect(v.floodProneShare).toBeGreaterThanOrEqual(0);
      expect(v.floodProneShare + v.moderateShare).toBeLessThanOrEqual(1.0001);
      expect(v.residentsFloodProne).toBeLessThanOrEqual(v.residents);
    }
    expect(c.hospitals.filter((h) => h.kind === 'hospital').length).toBeGreaterThan(20);
    const names = (c.rivers.features as { properties: { name: string } }[]).map((f) => f.properties.name).join(' ');
    expect(names).toMatch(/Bagmati/);
    expect(names).toMatch(/Bishnumati/);
    expect(c.floodProneImage.url).toMatch(/^data:image\/png;base64,/);
  });

  it('the river corridors are flood-prone and the Bagmati at Thapathali is "high"; Durbar Marg is not', () => {
    const cells = areaContext();
    expect(cells['c2769_8531']!.floodProneShare).toBeGreaterThan(0.05); // Thapathali / Bagmati
    expect(cells['c2771_8531']!.floodProneShare).toBeLessThan(0.05); // Durbar Marg area
  });

  it('nearest hospital is a real OSM facility nearby', () => {
    const h = nearestFacility({ lat: 27.7045, lng: 85.3145 })!; // Tundikhel
    expect(h.kind).toBe('hospital');
    expect(h.distanceM).toBeLessThan(2000);
  });

  it('decision support adds the terrain context (and a small labelled bump) only to areas with evidence', () => {
    const base = { now: '2026-07-20T06:00:00.000Z', reports: [], shelters: [], stock: {}, teams: [], cctv: [], snapshotVersion: 1 };
    const sos = [{ id: 's1', lat: 27.6912, lng: 85.3192, createdAt: '2026-07-20T05:55:00.000Z', status: 'open' as const, vulnerable: false, medical: false, householdSize: 3 }];
    const without = decide({ ...base, sos }).cells[0]!;
    const withCtx = decide({ ...base, sos, areaContext: areaContext() }).cells[0]!;
    expect(withCtx.context?.residents).toBeGreaterThan(0);
    expect(withCtx.score).toBe(without.score + 5);
    expect(withCtx.reasons.join(' ')).toMatch(/low-lying land next to a river/);
    // context alone never creates an area
    expect(decide({ ...base, sos: [], areaContext: areaContext() }).cells).toEqual([]);
  });

  it('admin endpoint serves the data with sources and the official 2024 figures; others are refused', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/api/admin/nepal-context', headers: { authorization: `Bearer ${tok.admin}` } });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.reference).toMatchObject({ deaths: REFERENCE_EVENT_2024.deaths, missing: 18, injured: 178 });
    expect(Object.keys(j.sources).sort()).toEqual(['health', 'residents', 'terrain']);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/admin/nepal-context', headers: { authorization: `Bearer ${tok.asha}` } })).statusCode).toBe(403);
  });

  it('SOS monitor shows the nearest hospital for an SOS in the region', async () => {
    const me = (await ctx.app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${tok.asha}` } })).json();
    await ctx.app.inject({
      method: 'POST',
      url: '/api/sync',
      headers: { authorization: `Bearer ${tok.asha}` },
      payload: { items: [{ kind: 'sos', data: { id: '01900000-0000-7000-8000-00000000aaaa', userId: me.user.id, lat: 27.6912, lng: 85.3192, accuracy: 20, locationSource: 'live', createdAt: new Date().toISOString(), source: 'app' } }] },
    });
    const mon = (await ctx.app.inject({ method: 'GET', url: '/api/admin/sos-monitor', headers: { authorization: `Bearer ${tok.admin}` } })).json();
    const s = mon.sos.find((x: { id: string }) => x.id === '01900000-0000-7000-8000-00000000aaaa');
    expect(s.nearestHospital.name.length).toBeGreaterThan(2);
    expect(s.areaContext.floodProneShare).toBeGreaterThan(0.05);
  });
});
