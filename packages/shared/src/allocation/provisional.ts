/**
 * Glue between the pure engine and the data model:
 *  - build engine input from a cached Snapshot + a FieldReport
 *  - wrap the result into an Allotment record (id/clock supplied by the CALLER,
 *    so the engine itself stays free of randomness and clock reads)
 *  - snapshot staleness
 *  - server-side reconciliation of provisional allotments against live stock
 */
import { RESOURCE_KEYS, type ResourceKey, type ResourceQty } from '../resources.ts';
import type { Allotment, FieldReport, Snapshot } from '../schemas.ts';
import { allocate, type AllocationInput, type AllocationResult, type DemandSite } from './engine.ts';

export function incidentSiteId(reportId: string): string {
  return `incident:${reportId}`;
}

export function buildAllocationInput(
  snapshot: Snapshot,
  report: Pick<FieldReport, 'id' | 'victimCount' | 'urgency' | 'requested'> | null,
  opts: { provisional: boolean; alreadyAllotted?: ResourceQty },
): AllocationInput {
  const sites: DemandSite[] = snapshot.sites.map((s) => ({
    id: s.id,
    kind: s.kind,
    density: s.density,
    urgency: s.urgency ?? 1,
    needs: s.needs,
  }));
  if (report) {
    sites.push({
      id: incidentSiteId(report.id),
      kind: 'incident',
      density: report.victimCount,
      urgency: report.urgency,
      needs: report.requested,
    });
  }
  return {
    snapshotVersion: snapshot.version,
    stock: snapshot.stock,
    sites,
    provisional: opts.provisional,
    alreadyAllotted: opts.alreadyAllotted,
  };
}

export function computeProvisionalAllotment(args: {
  snapshot: Snapshot;
  report: Pick<FieldReport, 'id' | 'victimCount' | 'urgency' | 'requested'>;
  deviceId: string;
  alreadyAllotted?: ResourceQty;
  id: string;
  createdAt: string;
}): { allotment: Allotment; result: AllocationResult } {
  const result = allocate(
    buildAllocationInput(args.snapshot, args.report, { provisional: true, alreadyAllotted: args.alreadyAllotted }),
  );
  const claim = result.perSite[incidentSiteId(args.report.id)] ?? {};
  return {
    result,
    allotment: {
      id: args.id,
      deviceId: args.deviceId,
      reportId: args.report.id,
      snapshotVersion: result.snapshotVersion,
      algorithmVersion: result.algorithmVersion,
      provisional: true,
      perSite: result.perSite,
      claim,
      shortfall: result.shortfall,
      createdAt: args.createdAt,
    },
  };
}

/** Sum of claims across a set of allotments (e.g. this device's earlier provisional ones). */
export function sumClaims(allotments: Pick<Allotment, 'claim'>[]): ResourceQty {
  const out: ResourceQty = {};
  for (const a of allotments) {
    for (const r of RESOURCE_KEYS) {
      const v = a.claim[r];
      if (v) out[r] = (out[r] ?? 0) + v;
    }
  }
  return out;
}

export function snapshotAgeMs(snapshot: Pick<Snapshot, 'createdAt'>, nowMs: number): number {
  return Math.max(0, nowMs - Date.parse(snapshot.createdAt));
}

export const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000;

export function isSnapshotStale(snapshot: Pick<Snapshot, 'createdAt'>, nowMs: number, thresholdMs = DEFAULT_STALE_MS): boolean {
  return snapshotAgeMs(snapshot, nowMs) > thresholdMs;
}

/* ---------------------------- reconciliation ---------------------------- */

export interface ResourceConflict {
  resource: ResourceKey;
  liveStock: number;
  claimed: number;
  overBy: number;
  allotmentIds: string[];
  devices: string[];
}

export interface ReconciliationResult {
  totals: ResourceQty;
  conflicts: ResourceConflict[];
}

/**
 * Sum every pending provisional claim; any resource whose total exceeds live
 * stock becomes a conflict for the administrator. Nothing is overwritten.
 */
export function reconcile(liveStock: ResourceQty, pending: Pick<Allotment, 'id' | 'deviceId' | 'claim'>[]): ReconciliationResult {
  const sorted = [...pending].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const totals = sumClaims(sorted);
  const conflicts: ResourceConflict[] = [];
  for (const r of RESOURCE_KEYS) {
    const claimed = totals[r] ?? 0;
    const live = liveStock[r] ?? 0;
    if (claimed > live) {
      const involved = sorted.filter((a) => (a.claim[r] ?? 0) > 0);
      conflicts.push({
        resource: r,
        liveStock: live,
        claimed,
        overBy: claimed - live,
        allotmentIds: involved.map((a) => a.id),
        devices: [...new Set(involved.map((a) => a.deviceId))].sort(),
      });
    }
  }
  return { totals, conflicts };
}
