/**
 * Allocation engine (§8B, §9). Hand-computed expectations are worked out in the
 * comments using the integer weight W = need × (maxD + 2·density) × (urgency + 3).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  allocate,
  AllocationInputError,
  ALGORITHM_VERSION,
  canonicalJson,
  computeProvisionalAllotment,
  isSnapshotStale,
  reconcile,
  RESOURCE_KEYS,
  snapshotAgeMs,
  sumClaims,
  type AllocationInput,
  type DemandSite,
  type ResourceKey,
} from '../src/index.ts';

const site = (id: string, needs: DemandSite['needs'], density = 0, urgency = 1, kind: DemandSite['kind'] = 'shelter'): DemandSite => ({
  id,
  kind,
  density,
  urgency,
  needs,
});
const run = (stock: AllocationInput['stock'], sites: DemandSite[], extra: Partial<AllocationInput> = {}) =>
  allocate({ snapshotVersion: 1, stock, sites, provisional: true, ...extra });

describe('hand-computed cases', () => {
  it('stock covers all needs → everyone gets full need', () => {
    const r = run({ boats: 10 }, [site('A', { boats: 4 }), site('B', { boats: 3 })]);
    expect(r.perSite).toEqual({ A: { boats: 4 }, B: { boats: 3 } });
    expect(r.shortfall).toEqual({ boats: 0 });
    expect(r.explanation.resources.boats!.mode).toBe('full');
  });

  it('density weighting: W_A=4·300·4=4800, W_B=4·200·4=3200 → 5×0.6=3, 5×0.4=2', () => {
    const r = run({ boats: 5 }, [site('A', { boats: 4 }, 100), site('B', { boats: 4 }, 50)]);
    expect(r.perSite).toEqual({ A: { boats: 3 }, B: { boats: 2 } });
    expect(r.shortfall).toEqual({ boats: 3 });
    const w = r.explanation.resources.boats!.weights;
    expect(w.map((x) => x.weight)).toEqual([6, 4]); // 4×1.5×1, 4×1.0×1
  });

  it('urgency weighting: weights 6×0.5×2=6 vs 6×0.5×1=3 → 4 and 2', () => {
    const r = run({ food_water: 6 }, [site('A', { food_water: 6 }, 0, 5), site('B', { food_water: 6 }, 0, 1)]);
    expect(r.perSite).toEqual({ A: { food_water: 4 }, B: { food_water: 2 } });
  });

  it('cap at need + surplus redistribution: A capped at 2, remaining 8 split 4/4', () => {
    // W_A = 2·300·8 = 4800, W_B = W_C = 10·100·4 = 4000, ΣW = 12800.
    // Round 1: 10·4800 ≥ 2·12800 → A capped (2). R = 8. Round 2: B,C get 8·½ = 4 each.
    const r = run({ boats: 10 }, [site('A', { boats: 2 }, 100, 5), site('B', { boats: 10 }), site('C', { boats: 10 })]);
    expect(r.perSite).toEqual({ A: { boats: 2 }, B: { boats: 4 }, C: { boats: 4 } });
    expect(r.shortfall).toEqual({ boats: 12 });
    expect(r.explanation.resources.boats!.rounds).toBeGreaterThanOrEqual(2);
  });

  it('largest remainder: 10 split three ways equally → 4/3/3 (tie → smallest id)', () => {
    const r = run({ boats: 10 }, [site('C', { boats: 10 }), site('A', { boats: 10 }), site('B', { boats: 10 })]);
    expect(r.perSite).toEqual({ A: { boats: 4 }, B: { boats: 3 }, C: { boats: 3 } });
  });

  it('ties: one unit, two identical sites → smaller id wins, deterministically', () => {
    const r = run({ boats: 1 }, [site('site-b', { boats: 1 }, 10), site('site-a', { boats: 1 }, 10)]);
    expect(r.perSite).toEqual({ 'site-a': { boats: 1 }, 'site-b': { boats: 0 } });
  });

  it('zero stock → nothing allocated, full shortfall', () => {
    const r = run({ boats: 0 }, [site('A', { boats: 3 }), site('B', { boats: 2 })]);
    expect(r.perSite).toEqual({ A: { boats: 0 }, B: { boats: 0 } });
    expect(r.shortfall).toEqual({ boats: 5 });
    expect(r.explanation.resources.boats!.mode).toBe('none');
  });

  it('missing stock entry is treated as zero', () => {
    const r = run({}, [site('A', { medical_supplies: 3 })]);
    expect(r.perSite.A).toEqual({ medical_supplies: 0 });
    expect(r.shortfall).toEqual({ medical_supplies: 3 });
  });

  it('zero need → no allocation and no shortfall entry', () => {
    const r = run({ boats: 5 }, [site('A', {}), site('B', { boats: 0 })]);
    expect(r.perSite).toEqual({ A: {}, B: {} });
    expect(r.shortfall).toEqual({});
  });

  it('single site gets min(stock, need)', () => {
    expect(run({ boats: 3 }, [site('A', { boats: 7 }, 99, 5)]).perSite.A).toEqual({ boats: 3 });
    expect(run({ boats: 9 }, [site('A', { boats: 7 })]).perSite.A).toEqual({ boats: 7 });
  });

  it('indivisible resources stay integers even with awkward ratios', () => {
    const r = run({ boats: 7, transportation: 2, first_aid_kits: 5 }, [
      site('A', { boats: 5, transportation: 3, first_aid_kits: 4 }, 33, 2),
      site('B', { boats: 5, transportation: 3, first_aid_kits: 4 }, 71, 4),
      site('C', { boats: 5, transportation: 3, first_aid_kits: 4 }, 12, 3),
    ]);
    for (const s of Object.values(r.perSite)) for (const v of Object.values(s)) expect(Number.isInteger(v)).toBe(true);
    expect(Object.values(r.perSite).reduce((t, s) => t + (s.boats ?? 0), 0)).toBe(7);
    expect(Object.values(r.perSite).reduce((t, s) => t + (s.transportation ?? 0), 0)).toBe(2);
  });

  it('extreme densities: 10,000,000 vs 0 → shares 3.75 / 1.25 → 4 / 1', () => {
    const r = run({ boats: 5 }, [site('A', { boats: 5 }, 10_000_000), site('B', { boats: 5 }, 0)]);
    expect(r.perSite).toEqual({ A: { boats: 4 }, B: { boats: 1 } });
  });

  it('all densities zero → density factor is neutral', () => {
    const r = run({ boats: 4 }, [site('A', { boats: 4 }), site('B', { boats: 4 })]);
    expect(r.perSite).toEqual({ A: { boats: 2 }, B: { boats: 2 } });
    expect(r.explanation.sites.every((s) => s.densityNorm === 0)).toBe(true);
  });

  it('alreadyAllotted reduces the stock this device may hand out', () => {
    const r = run({ boats: 5 }, [site('A', { boats: 5 })], { alreadyAllotted: { boats: 3 } });
    expect(r.perSite.A).toEqual({ boats: 2 });
    expect(r.explanation.effectiveStock.boats).toBe(2);
    const over = run({ boats: 5 }, [site('A', { boats: 5 })], { alreadyAllotted: { boats: 9 } });
    expect(over.perSite.A).toEqual({ boats: 0 });
  });

  it('output carries versions, provisional flag and explanation', () => {
    const r = run({ boats: 1 }, [site('A', { boats: 1 })], { snapshotVersion: 7, provisional: false });
    expect(r).toMatchObject({ snapshotVersion: 7, algorithmVersion: ALGORITHM_VERSION, provisional: false });
    expect(r.explanation.rule).toMatch(/weight/);
  });

  it('rejects invalid input', () => {
    expect(() => run({ boats: 1 }, [site('A', { boats: 1 }), site('A', { boats: 1 })])).toThrow(AllocationInputError);
    expect(() => run({ boats: -1 }, [site('A', { boats: 1 })])).toThrow(AllocationInputError);
    expect(() => run({ boats: 1.5 }, [site('A', { boats: 1 })])).toThrow(AllocationInputError);
    expect(() => run({ boats: 1 }, [site('A', { boats: 1 }, 1.5)])).toThrow(AllocationInputError);
    expect(() => run({ boats: 1 }, [site('A', { boats: 1 }, 0, 6)])).toThrow(AllocationInputError);
    expect(() => run({ unicorns: 1 } as never, [site('A', { boats: 1 })])).toThrow(AllocationInputError);
  });
});

describe('provisional allotment, staleness, reconciliation', () => {
  const snapshot = {
    version: 3,
    createdAt: '2026-07-01T00:00:00.000Z',
    stock: { boats: 4 },
    sites: [{ id: 'shelter-1', kind: 'shelter' as const, lat: 0, lng: 0, density: 100, urgency: 1, needs: { boats: 2 } }],
  };
  const report = { id: '01890000-0000-7000-8000-000000000001', victimCount: 40, urgency: 5, requested: { boats: 3 } };

  it('claim = allocation for the incident site; snapshot/algorithm versions recorded', () => {
    const { allotment, result } = computeProvisionalAllotment({ snapshot, report, deviceId: 'd1', id: '01890000-0000-7000-8000-0000000000a1', createdAt: '2026-07-01T01:00:00.000Z' });
    expect(allotment.provisional).toBe(true);
    expect(allotment.snapshotVersion).toBe(3);
    expect(allotment.claim).toEqual(result.perSite[`incident:${report.id}`]);
    expect((allotment.claim.boats ?? 0) + (result.perSite['shelter-1']!.boats ?? 0)).toBe(4);
  });

  it('snapshot age and stale threshold', () => {
    const now = Date.parse('2026-07-01T07:00:00.000Z');
    expect(snapshotAgeMs(snapshot, now)).toBe(7 * 3600_000);
    expect(isSnapshotStale(snapshot, now)).toBe(true);
    expect(isSnapshotStale(snapshot, now, 8 * 3600_000)).toBe(false);
  });

  it('reconcile flags over-claimed resources only', () => {
    const r = reconcile({ boats: 4, food_water: 100 }, [
      { id: 'b', deviceId: 'd2', claim: { boats: 3, food_water: 10 } },
      { id: 'a', deviceId: 'd1', claim: { boats: 3 } },
    ]);
    expect(r.totals).toEqual({ boats: 6, food_water: 10 });
    expect(r.conflicts).toEqual([{ resource: 'boats', liveStock: 4, claimed: 6, overBy: 2, allotmentIds: ['a', 'b'], devices: ['d1', 'd2'] }]);
    expect(sumClaims([{ claim: { boats: 1 } }, { claim: { boats: 2, other: 1 } }])).toEqual({ boats: 3, other: 1 });
  });
});

/* ------------------------------ properties ------------------------------ */

const resArb = fc.constantFrom<ResourceKey>(...RESOURCE_KEYS);
const needsArb = fc.dictionary(resArb, fc.integer({ min: 0, max: 500 }), { maxKeys: 4 }) as fc.Arbitrary<DemandSite['needs']>;
const siteArb = (id: string) =>
  fc.record({
    id: fc.constant(id),
    kind: fc.constantFrom<'shelter' | 'incident'>('shelter', 'incident'),
    density: fc.oneof(fc.integer({ min: 0, max: 2000 }), fc.constant(0), fc.integer({ min: 0, max: 10_000_000 })),
    urgency: fc.integer({ min: 1, max: 5 }),
    needs: needsArb,
  });
const inputArb = fc
  .integer({ min: 1, max: 8 })
  .chain((n) =>
    fc.record({
      sites: fc.tuple(...Array.from({ length: n }, (_, i) => siteArb(`s${String.fromCharCode(97 + i)}${i}`))),
      stock: fc.dictionary(resArb, fc.integer({ min: 0, max: 800 }), { maxKeys: 8 }) as fc.Arbitrary<DemandSite['needs']>,
    }),
  )
  .map(({ sites, stock }): AllocationInput => ({ snapshotVersion: 1, stock, sites, provisional: true }));

const totalAlloc = (r: ReturnType<typeof allocate>, k: ResourceKey) => Object.values(r.perSite).reduce((t, s) => t + (s[k] ?? 0), 0);
const totalNeed = (i: AllocationInput, k: ResourceKey) => i.sites.reduce((t, s) => t + (s.needs[k] ?? 0), 0);

describe('allocation properties (fast-check)', () => {
  const opts = { numRuns: 400, seed: 8_2026 };

  it('never exceeds stock; uses all stock or meets all needs', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const r = allocate(input);
        for (const k of RESOURCE_KEYS) {
          const given = totalAlloc(r, k);
          expect(given).toBeLessThanOrEqual(input.stock[k] ?? 0);
          expect(given).toBe(Math.min(input.stock[k] ?? 0, totalNeed(input, k)));
        }
      }),
      opts,
    );
  });

  it("never exceeds a site's need; all values non-negative integers", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const r = allocate(input);
        for (const s of input.sites) {
          for (const [k, v] of Object.entries(r.perSite[s.id]!)) {
            expect(Number.isInteger(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(s.needs[k as ResourceKey] ?? 0);
          }
        }
      }),
      opts,
    );
  });

  it('deterministic and byte-identical across calls', () => {
    fc.assert(fc.property(inputArb, (input) => JSON.stringify(allocate(input)) === JSON.stringify(allocate(structuredClone(input)))), opts);
  });

  it('order-independent (site order and key order)', () => {
    fc.assert(
      fc.property(inputArb, fc.integer(), (input, seed) => {
        const shuffled = [...input.sites].sort((a, b) => ((hash(a.id + seed) - hash(b.id + seed)) | 0));
        const reKeyed = shuffled.map((s) => ({ ...s, needs: Object.fromEntries(Object.entries(s.needs).reverse()) }));
        const stock = Object.fromEntries(Object.entries(input.stock).reverse());
        return canonicalJson(allocate(input)) === canonicalJson(allocate({ ...input, sites: reKeyed, stock }));
      }),
      opts,
    );
  });

  it("more density never reduces a site's share (others fixed)", () => {
    fc.assert(
      fc.property(inputArb, fc.nat(7), fc.integer({ min: 1, max: 5000 }), (input, idx, extra) => {
        const i = idx % input.sites.length;
        const before = allocate(input);
        const sites = input.sites.map((s, j) => (j === i ? { ...s, density: s.density + extra } : s));
        const after = allocate({ ...input, sites });
        const id = input.sites[i]!.id;
        for (const k of RESOURCE_KEYS) expect(after.perSite[id]![k] ?? 0).toBeGreaterThanOrEqual(before.perSite[id]![k] ?? 0);
      }),
      { ...opts, numRuns: 600 },
    );
  });

  it("more urgency never reduces a site's share (others fixed)", () => {
    fc.assert(
      fc.property(inputArb, fc.nat(7), (input, idx) => {
        const i = idx % input.sites.length;
        const s0 = input.sites[i]!;
        if (s0.urgency === 5) return;
        const after = allocate({ ...input, sites: input.sites.map((s, j) => (j === i ? { ...s, urgency: s.urgency + 1 } : s)) });
        const before = allocate(input);
        for (const k of RESOURCE_KEYS) expect(after.perSite[s0.id]![k] ?? 0).toBeGreaterThanOrEqual(before.perSite[s0.id]![k] ?? 0);
      }),
      opts,
    );
  });

  it('all needs met when stock suffices', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const stock = Object.fromEntries(RESOURCE_KEYS.map((k) => [k, totalNeed(input, k) + 1]));
        const r = allocate({ ...input, stock });
        for (const s of input.sites) for (const [k, v] of Object.entries(s.needs)) if (v > 0) expect(r.perSite[s.id]![k as ResourceKey]).toBe(v);
        for (const v of Object.values(r.shortfall)) expect(v).toBe(0);
      }),
      opts,
    );
  });
});

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h;
}
