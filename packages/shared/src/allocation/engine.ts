/**
 * Deterministic resource allocation engine (§8B). Identical on every phone and
 * on the server: pure function, no randomness, no clock reads, stable
 * tie-breaking by site id, and EXACT integer arithmetic (BigInt) so results are
 * byte-identical on every JS engine.
 *
 * Rule, per resource r:
 *   1. need(s,r) = requested quantity. If Σneed ≤ stock → every site gets its need.
 *   2. Otherwise weight(s) = need × (0.5 + densityNorm(s)) × urgencyFactor(s)
 *        densityNorm   = density / maxDensity            (0..1; 0 if maxDensity = 0)
 *        urgencyFactor = 1 + (urgency − 1)/4             (1..2)
 *   3. Allocate stock × weight / Σweight, capped at need; capped sites' surplus is
 *      redistributed iteratively ("water-filling"); the remaining fractional
 *      shares are rounded with the largest-remainder method (ties → smaller id).
 *   4. All quantities are integers (indivisible items are never split).
 *
 * Exactness: weight is proportional to the integer
 *        W(s) = need × (maxD + 2·density) × (urgency + 3)
 * because weight = need · (maxD+2d)/(2·maxD) · (u+3)/4 and the constant factor
 * cancels in every ratio. All comparisons use W with BigInt – no floating point
 * touches an allocated quantity. Floating weights appear only in the
 * human-readable `explanation`.
 */
import { RESOURCE_KEYS, type ResourceKey, type ResourceQty } from '../resources.ts';

export const ALGORITHM_VERSION = 'alloc-1.0.0';

export interface DemandSite {
  id: string;
  kind: 'shelter' | 'incident';
  /** integer headcount */
  density: number;
  /** 1..5 */
  urgency: number;
  needs: ResourceQty;
}

export interface AllocationInput {
  snapshotVersion: number;
  stock: ResourceQty;
  sites: DemandSite[];
  provisional: boolean;
  /** Stock this device already reserved in earlier provisional allotments; subtracted from stock. */
  alreadyAllotted?: ResourceQty;
}

export interface ResourceExplanation {
  stock: number;
  totalNeed: number;
  mode: 'none' | 'full' | 'weighted';
  rounds: number;
  weights: { siteId: string; need: number; weight: number; exactShare: string }[];
}

export interface AllocationResult {
  snapshotVersion: number;
  algorithmVersion: string;
  provisional: boolean;
  perSite: Record<string, ResourceQty>;
  shortfall: ResourceQty;
  explanation: {
    rule: string;
    maxDensity: number;
    effectiveStock: ResourceQty;
    sites: { id: string; kind: string; density: number; densityNorm: number; urgency: number; urgencyFactor: number }[];
    resources: Partial<Record<ResourceKey, ResourceExplanation>>;
  };
}

export class AllocationInputError extends Error {}

export function allocate(input: AllocationInput): AllocationResult {
  validate(input);
  const sites = [...input.sites].sort((a, b) => cmpId(a.id, b.id));
  const maxDensity = sites.reduce((m, s) => Math.max(m, s.density), 0);

  const perSite: Record<string, ResourceQty> = {};
  for (const s of sites) perSite[s.id] = {};
  const shortfall: ResourceQty = {};
  const effectiveStock: ResourceQty = {};
  const resources: Partial<Record<ResourceKey, ResourceExplanation>> = {};

  for (const r of RESOURCE_KEYS) {
    const rawStock = input.stock[r] ?? 0;
    const stock = Math.max(0, rawStock - (input.alreadyAllotted?.[r] ?? 0));
    const demand = sites.filter((s) => (s.needs[r] ?? 0) > 0);
    const totalNeed = demand.reduce((sum, s) => sum + (s.needs[r] ?? 0), 0);
    if (rawStock > 0 || input.stock[r] !== undefined || totalNeed > 0) effectiveStock[r] = stock;
    if (totalNeed === 0) continue;

    const exp: ResourceExplanation = { stock, totalNeed, mode: 'full', rounds: 0, weights: [] };
    resources[r] = exp;

    let alloc: Map<string, number>;
    if (totalNeed <= stock) {
      alloc = new Map(demand.map((s) => [s.id, s.needs[r]!]));
    } else if (stock === 0) {
      exp.mode = 'none';
      alloc = new Map(demand.map((s) => [s.id, 0]));
    } else {
      exp.mode = 'weighted';
      const res = weightedAllocate(stock, demand, r, maxDensity);
      alloc = res.alloc;
      exp.rounds = res.rounds;
      exp.weights = demand.map((s) => ({
        siteId: s.id,
        need: s.needs[r]!,
        weight: round6(s.needs[r]! * (0.5 + densityNorm(s.density, maxDensity)) * urgencyFactor(s.urgency)),
        exactShare: res.shares.get(s.id)!,
      }));
    }

    let given = 0;
    for (const s of demand) {
      const q = alloc.get(s.id) ?? 0;
      perSite[s.id]![r] = q;
      given += q;
    }
    const short = totalNeed - given;
    shortfall[r] = short;
  }

  return {
    snapshotVersion: input.snapshotVersion,
    algorithmVersion: ALGORITHM_VERSION,
    provisional: input.provisional,
    perSite,
    shortfall,
    explanation: {
      rule: 'weight = need × (0.5 + density/maxDensity) × (1 + (urgency−1)/4); proportional share capped at need; surplus redistributed; largest remainder; ties by site id',
      maxDensity,
      effectiveStock,
      sites: sites.map((s) => ({
        id: s.id,
        kind: s.kind,
        density: s.density,
        densityNorm: round6(densityNorm(s.density, maxDensity)),
        urgency: s.urgency,
        urgencyFactor: urgencyFactor(s.urgency),
      })),
      resources,
    },
  };
}

/** Water-filling with caps, then largest-remainder rounding. Exact BigInt maths. */
function weightedAllocate(
  stock: number,
  demand: DemandSite[],
  r: ResourceKey,
  maxDensity: number,
): { alloc: Map<string, number>; rounds: number; shares: Map<string, string> } {
  const W = new Map<string, bigint>();
  const need = new Map<string, bigint>();
  for (const s of demand) {
    const df = maxDensity === 0 ? 1n : BigInt(maxDensity) + 2n * BigInt(s.density);
    W.set(s.id, BigInt(s.needs[r]!) * df * (BigInt(s.urgency) + 3n));
    need.set(s.id, BigInt(s.needs[r]!));
  }
  const alloc = new Map<string, number>();
  const shares = new Map<string, string>();
  let active = demand.map((s) => s.id); // already id-sorted
  let R = BigInt(stock);
  let rounds = 0;

  // Water-filling: repeatedly cap every site whose proportional share ≥ its need.
  for (;;) {
    rounds++;
    const SW = active.reduce((sum, id) => sum + W.get(id)!, 0n);
    if (SW === 0n || R === 0n) break;
    const capped = active.filter((id) => R * W.get(id)! >= need.get(id)! * SW);
    if (capped.length === 0) break;
    for (const id of capped) {
      alloc.set(id, Number(need.get(id)!));
      shares.set(id, `${need.get(id)!} (capped at need)`);
      R -= need.get(id)!;
    }
    const cappedSet = new Set(capped);
    active = active.filter((id) => !cappedSet.has(id));
    if (active.length === 0) break;
  }

  // Largest remainder over the uncapped sites. Every exact share < need, so +1 never exceeds need.
  const SW = active.reduce((sum, id) => sum + W.get(id)!, 0n);
  if (active.length > 0) {
    if (SW === 0n || R === 0n) {
      for (const id of active) {
        alloc.set(id, 0);
        shares.set(id, '0');
      }
    } else {
      const rows = active.map((id) => {
        const num = R * W.get(id)!;
        return { id, floor: num / SW, rem: num % SW };
      });
      let left = R - rows.reduce((sum, x) => sum + x.floor, 0n);
      rows.sort((a, b) => (a.rem === b.rem ? cmpId(a.id, b.id) : a.rem > b.rem ? -1 : 1));
      for (const row of rows) {
        let q = row.floor;
        if (left > 0n) {
          q += 1n;
          left -= 1n;
        }
        alloc.set(row.id, Number(q));
        shares.set(row.id, `${R * W.get(row.id)!}/${SW}`);
      }
    }
  }
  return { alloc, rounds, shares };
}

export function densityNorm(density: number, maxDensity: number): number {
  return maxDensity === 0 ? 0 : density / maxDensity;
}

export function urgencyFactor(urgency: number): number {
  return 1 + (urgency - 1) / 4;
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** Plain code-unit comparison: locale-independent, identical everywhere. */
function cmpId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function validate(input: AllocationInput) {
  const ids = new Set<string>();
  for (const s of input.sites) {
    if (ids.has(s.id)) throw new AllocationInputError(`duplicate site id ${s.id}`);
    ids.add(s.id);
    if (!Number.isSafeInteger(s.density) || s.density < 0) throw new AllocationInputError(`site ${s.id}: density must be a non-negative integer`);
    if (!Number.isInteger(s.urgency) || s.urgency < 1 || s.urgency > 5) throw new AllocationInputError(`site ${s.id}: urgency must be 1..5`);
    for (const [k, v] of Object.entries(s.needs)) checkQty(`site ${s.id} need ${k}`, k, v);
  }
  for (const [k, v] of Object.entries(input.stock)) checkQty(`stock ${k}`, k, v);
  for (const [k, v] of Object.entries(input.alreadyAllotted ?? {})) checkQty(`alreadyAllotted ${k}`, k, v);
}

function checkQty(where: string, key: string, v: unknown) {
  if (!(RESOURCE_KEYS as readonly string[]).includes(key)) throw new AllocationInputError(`${where}: unknown resource`);
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new AllocationInputError(`${where}: must be a non-negative integer`);
}
