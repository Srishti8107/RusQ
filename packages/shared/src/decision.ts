/**
 * RULE-BASED DECISION SUPPORT (§10.4). ADVISORY ONLY: it produces
 * recommendations with their reasoning; an administrator approves or rejects
 * each one (audit-logged by the server). Nothing here acts on its own.
 *
 * Pure and deterministic: `now` is an input (no clock reads), ties break by id,
 * distances use the engine-independent `distanceM`, scores are integers.
 * Resource distribution reuses the Phase 1 allocation engine unchanged.
 *
 * Areas are ≈1.1 km grid cells (geo.cellOf). Per cell:
 *   people  = max(Σ report victim counts + Σ household size of open SOS, CCTV crowd)
 *   score   = 2·people + 10·openSOS + 10·vulnerableSOS + 8·maxUrgency
 *             + 15·flooded + 10·blocked + 10·unattendedSOS
 *   level   = critical ≥ 100 · high ≥ 50 · medium ≥ 20 · else low
 */
import { allocate, type AllocationResult, type DemandSite } from './allocation/engine.ts';
import { canonicalJson } from './canonical.ts';
import type { CctvSignal } from './cctv.ts';
import { cellOf, distanceM, fnv1a, kmText } from './geo.ts';
import { RESOURCE_KEYS, RESOURCES, type HazardLabel, type ResourceKey, type ResourceQty } from './resources.ts';
import type { Site } from './schemas.ts';

export const RULES_VERSION = 'rules-1.0.0';

export type SosOpsStatus = 'open' | 'acknowledged' | 'assigned' | 'resolved';

export interface DsSos {
  id: string;
  serverId?: string;
  lat: number | null;
  lng: number | null;
  createdAt: string;
  status: SosOpsStatus;
  vulnerable: boolean;
  medical: boolean;
  householdSize: number;
}

export interface DsReport {
  id: string;
  serverId?: string;
  teamId: string;
  lat: number;
  lng: number;
  victimCount: number;
  urgency: number;
  hazards: HazardLabel[];
  requested: ResourceQty;
  createdAt: string;
}

export interface DsTeam {
  teamId: string;
  name: string;
  skills: string[];
  lat: number | null;
  lng: number | null;
}

export interface DecisionInput {
  now: string;
  sos: DsSos[];
  reports: DsReport[];
  shelters: Site[];
  stock: ResourceQty;
  teams: DsTeam[];
  cctv: CctvSignal[];
  snapshotVersion: number;
  /** minutes an open SOS may wait without a field report nearby before it is "unattended" */
  unattendedMinutes?: number;
}

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type RecKind = 'priority_area' | 'victim_concentration' | 'personnel' | 'team_assignment' | 'resource_distribution' | 'unmet_need';

export const REC_KIND_LABELS: Record<RecKind, string> = {
  priority_area: 'Priority area',
  victim_concentration: 'Victim concentration',
  personnel: 'Personnel estimate',
  team_assignment: 'Team–skill match',
  resource_distribution: 'Resource distribution',
  unmet_need: 'Urgent unmet need',
};

export interface CellSummary {
  cellId: string;
  lat: number;
  lng: number;
  people: number;
  peopleReported: number;
  peopleSos: number;
  crowdCctv: number;
  openSos: number;
  vulnerableSos: number;
  medicalSos: number;
  unattendedSos: number;
  maxUrgency: number;
  hazards: HazardLabel[];
  flooded: boolean;
  blocked: boolean;
  requested: ResourceQty;
  score: number;
  severity: Severity;
  reasons: string[];
  nearestShelter: { id: string; name: string; distanceM: number } | null;
  evidence: { sos: string[]; reports: string[]; cctv: string[] };
}

export interface Recommendation {
  id: string;
  kind: RecKind;
  severity: Severity;
  score: number;
  title: string;
  summary: string;
  reasoning: string[];
  evidence: { sos: string[]; reports: string[]; cctv: string[] };
  location: { lat: number; lng: number } | null;
  proposal: Record<string, unknown>;
}

export interface DecisionOutput {
  rulesVersion: string;
  generatedFor: string;
  cells: CellSummary[];
  recommendations: Recommendation[];
  allocation: AllocationResult | null;
}

const SEV_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function severityOf(score: number): Severity {
  return score >= 100 ? 'critical' : score >= 50 ? 'high' : score >= 20 ? 'medium' : 'low';
}

function minutesBetween(fromIso: string, toIso: string): number {
  return Math.floor((Date.parse(toIso) - Date.parse(fromIso)) / 60000);
}

function nearestShelter(shelters: Site[], p: { lat: number; lng: number }) {
  let best: { id: string; name: string; distanceM: number } | null = null;
  for (const s of [...shelters].sort((a, b) => cmp(a.id, b.id))) {
    const d = distanceM(p, s);
    if (!best || d < best.distanceM) best = { id: s.id, name: s.name ?? s.id, distanceM: d };
  }
  return best;
}

/* ------------------------------ cells ------------------------------ */

export function summariseCells(input: DecisionInput): CellSummary[] {
  const unattendedMin = input.unattendedMinutes ?? 30;
  const m = new Map<string, CellSummary>();
  const get = (lat: number, lng: number) => {
    const c = cellOf(lat, lng);
    let s = m.get(c.id);
    if (!s) {
      s = {
        cellId: c.id, lat: c.lat, lng: c.lng, people: 0, peopleReported: 0, peopleSos: 0, crowdCctv: 0, openSos: 0, vulnerableSos: 0, medicalSos: 0,
        unattendedSos: 0, maxUrgency: 0, hazards: [], flooded: false, blocked: false, requested: {}, score: 0, severity: 'low', reasons: [],
        nearestShelter: null, evidence: { sos: [], reports: [], cctv: [] },
      };
      m.set(c.id, s);
    }
    return s;
  };

  for (const r of [...input.reports].sort((a, b) => cmp(a.id, b.id))) {
    const c = get(r.lat, r.lng);
    c.peopleReported += r.victimCount;
    c.maxUrgency = Math.max(c.maxUrgency, r.urgency);
    for (const h of r.hazards) if (!c.hazards.includes(h)) c.hazards.push(h);
    if (r.hazards.includes('flooded street')) c.flooded = true;
    if (r.hazards.includes('blocked road') || r.hazards.includes('damaged bridge') || r.hazards.includes('landslide debris')) c.blocked = true;
    for (const k of RESOURCE_KEYS) if (r.requested[k]) c.requested[k] = (c.requested[k] ?? 0) + r.requested[k]!;
    c.evidence.reports.push(r.serverId ?? r.id);
  }

  for (const s of [...input.sos].sort((a, b) => cmp(a.id, b.id))) {
    if (s.lat === null || s.lng === null || s.status === 'resolved') continue;
    const c = get(s.lat, s.lng);
    c.openSos++;
    c.peopleSos += Math.max(1, s.householdSize);
    if (s.vulnerable) c.vulnerableSos++;
    if (s.medical) c.medicalSos++;
    // unattended: still "open" (nobody acknowledged it) for too long and no field report in this cell since it was sent
    const waited = minutesBetween(s.createdAt, input.now);
    const reportAfter = input.reports.some((r) => cellOf(r.lat, r.lng).id === c.cellId && r.createdAt >= s.createdAt);
    if (s.status === 'open' && waited >= unattendedMin && !reportAfter) c.unattendedSos++;
    c.evidence.sos.push(s.serverId ?? s.id);
  }

  for (const k of [...input.cctv].sort((a, b) => cmp(a.cameraId, b.cameraId))) {
    const c = get(k.lat, k.lng);
    c.crowdCctv += k.crowd;
    if (k.flooded >= 0.5) c.flooded = true;
    if (k.blockage >= 0.5) c.blocked = true;
    c.evidence.cctv.push(k.cameraId);
  }

  for (const c of m.values()) {
    c.people = Math.max(c.peopleReported + c.peopleSos, c.crowdCctv);
    const parts: [number, string][] = [
      [2 * c.people, `${c.people} people (reports ${c.peopleReported} + SOS households ${c.peopleSos}${c.crowdCctv ? `, CCTV sample crowd ${c.crowdCctv}` : ''}; the larger is used) × 2`],
      [10 * c.openSos, `${c.openSos} open SOS × 10`],
      [10 * c.vulnerableSos, `${c.vulnerableSos} SOS from vulnerable people × 10`],
      [8 * c.maxUrgency, `highest report urgency ${c.maxUrgency} × 8`],
      [c.flooded ? 15 : 0, 'flooding reported or seen on sample CCTV +15'],
      [c.blocked ? 10 : 0, 'road blocked / bridge damaged +10'],
      [10 * c.unattendedSos, `${c.unattendedSos} SOS waiting ≥ ${unattendedMin} min with no field report nearby × 10`],
    ];
    c.score = parts.reduce((s, [v]) => s + v, 0);
    c.severity = severityOf(c.score);
    c.reasons = parts.filter(([v]) => v > 0).map(([v, t]) => `${t} = ${v}`);
    c.hazards.sort();
    c.nearestShelter = nearestShelter(input.shelters, c);
  }
  return [...m.values()].sort((a, b) => b.score - a.score || cmp(a.cellId, b.cellId));
}

/* -------------------------- recommendations -------------------------- */

function recId(kind: RecKind, key: string, content: unknown): string {
  return `${kind}:${key}:${fnv1a(canonicalJson(content))}`;
}

function where(c: CellSummary): string {
  return c.nearestShelter ? `${kmText(c.nearestShelter.distanceM)} from ${c.nearestShelter.name}` : `around ${c.lat.toFixed(3)}, ${c.lng.toFixed(3)}`;
}

/** Skills a cell needs, with the rule that triggered each. */
export function requiredSkills(c: Pick<CellSummary, 'flooded' | 'hazards' | 'vulnerableSos' | 'medicalSos'>): { skill: string; why: string }[] {
  const out: { skill: string; why: string }[] = [];
  if (c.flooded) out.push({ skill: 'boat', why: 'flooding → boat handling' });
  if (c.hazards.some((h) => h === 'collapsed building' || h === 'landslide debris')) out.push({ skill: 'search', why: 'collapse / landslide → search & rescue' });
  if (c.medicalSos > 0 || c.hazards.includes('fire or smoke')) out.push({ skill: 'medical', why: 'medical need or fire → medical' });
  if (c.vulnerableSos > 0 && !out.some((o) => o.skill === 'medical')) out.push({ skill: 'first_aid', why: 'vulnerable people → first aid' });
  return out;
}

export function personnelEstimate(c: Pick<CellSummary, 'people' | 'maxUrgency' | 'flooded' | 'hazards' | 'vulnerableSos' | 'medicalSos'>) {
  const perRescuer = c.maxUrgency >= 4 ? 5 : 10;
  const rescuers = Math.max(1, Math.ceil(c.people / perRescuer));
  const boats = c.flooded ? Math.max(1, Math.ceil(c.people / 6)) : 0;
  const needsMedic = c.medicalSos > 0 || c.vulnerableSos > 0 || c.hazards.some((h) => h === 'collapsed building' || h === 'fire or smoke' || h === 'landslide debris');
  const medics = needsMedic ? Math.max(1, Math.ceil(c.people / 25)) : 0;
  return {
    rescuers,
    boats,
    medics,
    reasoning: [
      `Rescuers: 1 per ${perRescuer} people (${c.maxUrgency >= 4 ? 'urgency ≥ 4' : 'urgency < 4'}) → ceil(${c.people}/${perRescuer}) = ${rescuers}`,
      c.flooded ? `Boats: flooding → 1 boat per 6 people → ceil(${c.people}/6) = ${boats}` : 'Boats: no flooding reported → 0',
      needsMedic ? `Medics: vulnerable / medical / injury hazard present → 1 per 25 people (min 1) = ${medics}` : 'Medics: no medical indicator → 0',
    ],
  };
}

export function decide(input: DecisionInput): DecisionOutput {
  const cells = summariseCells(input);
  const recs: Recommendation[] = [];
  const priority = cells.filter((c) => c.severity === 'critical' || c.severity === 'high');

  // 1. priority areas
  priority.forEach((c, i) => {
    const proposal = { cellId: c.cellId, rank: i + 1, action: 'Dispatch rescue here first' };
    recs.push({
      id: recId('priority_area', c.cellId, { proposal, score: c.score }),
      kind: 'priority_area',
      severity: c.severity,
      score: c.score,
      title: `Priority #${i + 1}: area ${where(c)}`,
      summary: `Score ${c.score} (${c.severity}). ${c.people} people, ${c.openSos} open SOS${c.hazards.length ? `, hazards: ${c.hazards.join(', ')}` : ''}.`,
      reasoning: [...c.reasons, `Total score ${c.score} → ${c.severity} (critical ≥ 100, high ≥ 50, medium ≥ 20)`],
      evidence: c.evidence,
      location: { lat: c.lat, lng: c.lng },
      proposal,
    });
  });

  // 2. victim concentrations → evacuation target with free capacity
  const shelters = [...input.shelters].filter((s) => s.kind === 'shelter').sort((a, b) => cmp(a.id, b.id));
  for (const c of cells.filter((x) => x.people >= 15)) {
    const options = shelters
      .map((s) => ({ s, free: Math.max(0, (s.capacity ?? 0) - s.density), d: distanceM(c, s) }))
      .filter((o) => o.free > 0)
      .sort((a, b) => a.d - b.d || cmp(a.s.id, b.s.id));
    const target = options.find((o) => o.free >= c.people && o.d <= 5000) ?? options[0] ?? null;
    const proposal = target
      ? { cellId: c.cellId, people: c.people, shelterId: target.s.id, shelterName: target.s.name ?? target.s.id, freeCapacity: target.free, distanceM: target.d }
      : { cellId: c.cellId, people: c.people, shelterId: null };
    recs.push({
      id: recId('victim_concentration', c.cellId, proposal),
      kind: 'victim_concentration',
      severity: c.people >= 40 ? 'critical' : c.people >= 25 ? 'high' : 'medium',
      score: c.people,
      title: `${c.people} people concentrated ${where(c)}`,
      summary: target ? `Suggest moving people to ${target.s.name} (${target.free} free places, ${kmText(target.d)}).` : 'No shelter in the snapshot has free capacity – open a new site.',
      reasoning: [
        `Concentration rule: an area with ≥ 15 people (here ${c.people})`,
        `People estimate: max(reports ${c.peopleReported} + SOS households ${c.peopleSos}, sample CCTV crowd ${c.crowdCctv})`,
        target
          ? `Shelter choice: nearest shelter within 5 km with room for everyone, else the nearest with any room → ${target.s.name}: capacity ${target.s.capacity} − present ${target.s.density} = ${target.free} free`
          : 'Shelter choice: every shelter is full (capacity − present ≤ 0)',
      ],
      evidence: c.evidence,
      location: { lat: c.lat, lng: c.lng },
      proposal,
    });
  }
  for (const s of shelters) {
    if (!s.capacity) continue;
    const pct = Math.floor((100 * s.density) / s.capacity);
    if (pct < 90) continue;
    const proposal = { shelterId: s.id, occupancyPct: pct, action: 'Stop sending people here; open overflow site' };
    recs.push({
      id: recId('victim_concentration', s.id, proposal),
      kind: 'victim_concentration',
      severity: pct >= 100 ? 'critical' : 'high',
      score: pct,
      title: `${s.name ?? s.id} is ${pct} % full`,
      summary: `${s.density} people for ${s.capacity} places.`,
      reasoning: [`Shelter occupancy rule: ≥ 90 % full → warn (${s.density}/${s.capacity} = ${pct} %)`],
      evidence: { sos: [], reports: [], cctv: [] },
      location: { lat: s.lat, lng: s.lng },
      proposal,
    });
  }

  // 3. personnel per priority area
  for (const c of priority) {
    const p = personnelEstimate(c);
    const proposal = { cellId: c.cellId, rescuers: p.rescuers, boats: p.boats, medics: p.medics };
    recs.push({
      id: recId('personnel', c.cellId, proposal),
      kind: 'personnel',
      severity: c.severity,
      score: c.score,
      title: `Send ${p.rescuers} rescuer${p.rescuers === 1 ? '' : 's'}${p.boats ? `, ${p.boats} boat${p.boats === 1 ? '' : 's'}` : ''}${p.medics ? `, ${p.medics} medic${p.medics === 1 ? '' : 's'}` : ''} to the area ${where(c)}`,
      summary: `Estimate for ${c.people} people at urgency ${c.maxUrgency || '–'}.`,
      reasoning: p.reasoning,
      evidence: c.evidence,
      location: { lat: c.lat, lng: c.lng },
      proposal,
    });
  }

  // 4. team–skill matching: greedy by area score, each team at most once
  const free = new Set(input.teams.map((t) => t.teamId));
  for (const c of priority) {
    const need = requiredSkills(c);
    const needSkills = need.map((n) => n.skill);
    const ranked = input.teams
      .filter((t) => free.has(t.teamId))
      .map((t) => {
        const matched = needSkills.filter((s) => t.skills.includes(s) || (s === 'first_aid' && t.skills.includes('medical')));
        const d = t.lat !== null && t.lng !== null ? distanceM(c, { lat: t.lat, lng: t.lng }) : null;
        return { t, matched, d, score: matched.length * 100_000 - (d ?? 50_000) };
      })
      .sort((a, b) => b.score - a.score || cmp(a.t.teamId, b.t.teamId));
    const best = ranked[0];
    if (!best) continue;
    free.delete(best.t.teamId);
    const missing = needSkills.filter((s) => !best.matched.includes(s));
    const proposal = { teamId: best.t.teamId, cellId: c.cellId, requiredSkills: needSkills, matchedSkills: best.matched, missingSkills: missing, distanceM: best.d };
    recs.push({
      id: recId('team_assignment', `${c.cellId}:${best.t.teamId}`, proposal),
      kind: 'team_assignment',
      severity: c.severity,
      score: c.score,
      title: `Assign ${best.t.name} to the area ${where(c)}`,
      summary: `${best.matched.length}/${needSkills.length || 0} needed skills${missing.length ? ` – missing: ${missing.join(', ')}` : ''}${best.d !== null ? `, about ${kmText(best.d)} away` : ', team position unknown'}.`,
      reasoning: [
        need.length ? `Needed skills: ${need.map((n) => `${n.skill} (${n.why})`).join('; ')}` : 'No special skill needed – any team',
        `Team skills: ${best.t.skills.join(', ') || 'none recorded'}`,
        'Ranking: most matching skills first, then shortest distance (from the team’s latest report), then team id',
        `Areas are matched in priority order; each team is suggested once (${ranked.length} team(s) were still free)`,
      ],
      evidence: c.evidence,
      location: { lat: c.lat, lng: c.lng },
      proposal,
    });
  }

  // 5. resource distribution: the SAME Phase 1 engine over shelters + area demand
  const demand: DemandSite[] = shelters.map((s) => ({ id: s.id, kind: 'shelter', density: s.density, urgency: s.urgency ?? 1, needs: s.needs }));
  for (const c of cells) {
    if (RESOURCE_KEYS.some((k) => (c.requested[k] ?? 0) > 0)) {
      demand.push({ id: `area-${c.cellId}`, kind: 'incident', density: c.people, urgency: Math.max(1, c.maxUrgency), needs: c.requested });
    }
  }
  let allocation: AllocationResult | null = null;
  if (demand.length) {
    allocation = allocate({ snapshotVersion: input.snapshotVersion, stock: input.stock, sites: demand, provisional: false });
    const proposal = { perSite: allocation.perSite, algorithmVersion: allocation.algorithmVersion };
    const short = RESOURCE_KEYS.filter((k) => (allocation!.shortfall[k] ?? 0) > 0);
    recs.push({
      id: recId('resource_distribution', 'all', proposal),
      kind: 'resource_distribution',
      severity: short.length ? 'high' : 'medium',
      score: demand.length,
      title: `Distribute live stock across ${demand.length} sites`,
      summary: short.length ? `Stock does not cover every need (${short.map((k) => RESOURCES[k].label).join(', ')}).` : 'Live stock covers every requested need.',
      reasoning: [
        `Same deterministic engine as the phones (${allocation.algorithmVersion}): weight = need × (0.5 + density/maxDensity) × (1 + (urgency−1)/4), capped at need, largest remainder`,
        ...RESOURCE_KEYS.filter((k) => allocation!.explanation.resources[k]).map((k) => {
          const e = allocation!.explanation.resources[k]!;
          return `${RESOURCES[k].label}: stock ${e.stock}, total need ${e.totalNeed} → ${e.mode === 'full' ? 'everyone gets their full need' : e.mode === 'weighted' ? 'shared by weight' : 'nothing requested'}`;
        }),
      ],
      evidence: { sos: [], reports: input.reports.map((r) => r.serverId ?? r.id).sort(), cctv: [] },
      location: null,
      proposal,
    });

    // 6a. unmet needs = shortfall after the fair share
    for (const k of short) {
      const e = allocation.explanation.resources[k]!;
      const gap = allocation.shortfall[k]!;
      const proposal = { resource: k, shortfall: gap, action: `Procure or request ${gap} ${RESOURCES[k].unit}` };
      recs.push({
        id: recId('unmet_need', k, proposal),
        kind: 'unmet_need',
        severity: k === 'boats' || k === 'medical_supplies' || k === 'first_aid_kits' ? 'critical' : 'high',
        score: gap,
        title: `Short of ${gap} ${RESOURCES[k].unit}: ${RESOURCES[k].label}`,
        summary: `Requested ${e.totalNeed}, live stock ${e.stock}.`,
        reasoning: [`Shortfall = total need ${e.totalNeed} − stock ${e.stock} = ${gap}`, 'Life-safety items (boats, medical supplies, first-aid kits) are marked critical'],
        evidence: { sos: [], reports: [], cctv: [] },
        location: null,
        proposal,
      });
    }
  }

  // 6b. unmet needs = SOS waiting with nobody attending
  for (const c of cells.filter((x) => x.unattendedSos > 0)) {
    const proposal = { cellId: c.cellId, unattendedSos: c.unattendedSos, action: 'Contact the people (phone numbers in the SOS) and dispatch the nearest team' };
    recs.push({
      id: recId('unmet_need', `sos-${c.cellId}`, proposal),
      kind: 'unmet_need',
      severity: 'critical',
      score: 50 + c.unattendedSos,
      title: `${c.unattendedSos} SOS waiting with no response ${where(c)}`,
      summary: 'Still "open" (nobody acknowledged them) and no field report from this area since they were sent.',
      reasoning: [`Rule: SOS still open after ${input.unattendedMinutes ?? 30} minutes and no field report in the same area afterwards`],
      evidence: { sos: c.evidence.sos, reports: [], cctv: [] },
      location: { lat: c.lat, lng: c.lng },
      proposal,
    });
  }

  recs.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.score - a.score || cmp(a.id, b.id));
  return { rulesVersion: RULES_VERSION, generatedFor: input.now, cells, recommendations: recs, allocation };
}

/* ------------------------------ SOS triage ------------------------------ */

export interface SosTriage {
  level: 1 | 2 | 3 | 4 | 5;
  reasons: string[];
}

/** Urgency level for the SOS monitor (rule-based, shown with its reasons). */
export function sosTriage(
  s: { createdAt: string; lat: number | null; profile?: { age?: number; needs?: readonly string[]; medicalNotes?: string } },
  ctx: { now: string; areaSeverity?: Severity | null; vulnerable: boolean; medical: boolean },
): SosTriage {
  let level = 3;
  const reasons = ['SOS: a person asked for help (base level 3)'];
  if (ctx.vulnerable) {
    level++;
    reasons.push('vulnerable person (child, elderly, disability or pregnant) +1');
  }
  if (ctx.medical) {
    level++;
    reasons.push('medical need in profile +1');
  }
  if (ctx.areaSeverity === 'critical' || ctx.areaSeverity === 'high') {
    level++;
    reasons.push(`area is ${ctx.areaSeverity} on the priority map +1`);
  }
  const waited = minutesBetween(s.createdAt, ctx.now);
  if (waited >= 60) {
    level++;
    reasons.push(`waiting ${waited} min +1`);
  }
  if (s.lat === null) reasons.push('no location – call the contacts in the profile');
  return { level: Math.min(5, level) as SosTriage['level'], reasons };
}
