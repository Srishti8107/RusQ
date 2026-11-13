/**
 * Missing-person workflow (§10.6) – SAMPLE DATA ONLY.
 *
 *   reported ──propose_candidates──▶ candidate_found ──start_review──▶ under_review
 *      ▲                                                                  │   │
 *      └────────────────────── reject_candidates ◀────────────────────────┘   │ verify (named admin,
 *                                                                              ▼  checklist complete)
 *                                                    announced ◀──announce── verified
 *
 * States can never be skipped: `transition()` is the only way to change state and
 * it accepts exactly the edges above. Families see NOTHING beyond "reported"
 * until a named administrator has verified the match (`familyView`).
 */
import type { MissingReport } from './schemas.ts';
import { distanceM } from './geo.ts';

export const MISSING_STATES = ['reported', 'candidate_found', 'under_review', 'verified', 'announced'] as const;
export type MissingState = (typeof MISSING_STATES)[number];

export const MISSING_STATE_LABELS: Record<MissingState, string> = {
  reported: 'Reported',
  candidate_found: 'Candidate found',
  under_review: 'Under review',
  verified: 'Verified by named admin',
  announced: 'Announced',
};

export type MissingAction = 'propose_candidates' | 'start_review' | 'reject_candidates' | 'verify' | 'announce';

const EDGES: Record<MissingAction, { from: MissingState; to: MissingState }> = {
  propose_candidates: { from: 'reported', to: 'candidate_found' },
  start_review: { from: 'candidate_found', to: 'under_review' },
  reject_candidates: { from: 'under_review', to: 'reported' },
  verify: { from: 'under_review', to: 'verified' },
  announce: { from: 'verified', to: 'announced' },
};

/** The checks an administrator must confirm before verifying (all mandatory). */
export const VERIFY_CHECKLIST = [
  { id: 'compared', label: 'I compared every evidence item with the family’s report' },
  { id: 'contacted_shelter', label: 'I contacted the shelter / registry and they confirmed the person is there' },
  { id: 'identity', label: 'Identity was confirmed in person or by phone (not only by this software)' },
] as const;
export type VerifyCheckId = (typeof VERIFY_CHECKLIST)[number]['id'];

export interface VerifyInput {
  actorId: string;
  actorName: string;
  candidateId: string;
  checks: Partial<Record<VerifyCheckId, boolean>>;
  note: string;
}

export class WorkflowError extends Error {}

export interface MissingCase {
  state: MissingState;
  candidates: MissingCandidate[];
  verifiedBy?: { id: string; name: string; at: string; candidateId: string; note: string } | null;
}

/**
 * Pure transition function. Throws WorkflowError for any illegal edge or
 * missing precondition – the server maps that to HTTP 409/400.
 */
export function transition(c: MissingCase, action: MissingAction, ctx: { at: string; candidates?: MissingCandidate[]; verify?: VerifyInput; actorRole?: string }): MissingCase {
  const edge = EDGES[action];
  if (!edge) throw new WorkflowError(`unknown action ${action}`);
  if (c.state !== edge.from) {
    throw new WorkflowError(`cannot ${action.replace(/_/g, ' ')} from state "${MISSING_STATE_LABELS[c.state]}" – states cannot be skipped`);
  }
  if (action !== 'propose_candidates' && ctx.actorRole !== 'admin') throw new WorkflowError('only an administrator can do this');
  switch (action) {
    case 'propose_candidates': {
      const cands = ctx.candidates ?? [];
      if (cands.length === 0) throw new WorkflowError('no candidates to propose');
      return { ...c, state: edge.to, candidates: cands, verifiedBy: null };
    }
    case 'start_review':
      return { ...c, state: edge.to };
    case 'reject_candidates':
      return { ...c, state: edge.to, candidates: [], verifiedBy: null };
    case 'verify': {
      const v = ctx.verify;
      if (!v) throw new WorkflowError('verification details required');
      if (!v.actorName.trim() || !v.actorId) throw new WorkflowError('verification must be done by a named administrator');
      if (!c.candidates.some((x) => x.foundPersonId === v.candidateId)) throw new WorkflowError('chosen candidate is not on this case');
      const missing = VERIFY_CHECKLIST.filter((k) => v.checks[k.id] !== true);
      if (missing.length) throw new WorkflowError(`verification checklist incomplete: ${missing.map((m) => m.id).join(', ')}`);
      if (v.note.trim().length < 10) throw new WorkflowError('write a short verification note (at least 10 characters)');
      return { ...c, state: edge.to, verifiedBy: { id: v.actorId, name: v.actorName.trim(), at: ctx.at, candidateId: v.candidateId, note: v.note.trim() } };
    }
    case 'announce':
      if (!c.verifiedBy) throw new WorkflowError('cannot announce without a recorded verification');
      return { ...c, state: edge.to };
  }
}

export function allowedActions(state: MissingState): MissingAction[] {
  return (Object.keys(EDGES) as MissingAction[]).filter((a) => EDGES[a].from === state);
}

/* --------------------------- what families see --------------------------- */

export interface FamilyView {
  id: string;
  personName: string;
  status: 'reported' | 'verified' | 'announced';
  message: string;
  found?: { shelterName: string; verifiedBy: string; verifiedAt: string };
}

/**
 * Redaction for the reporting family. Before `verified` every internal state
 * (candidate found, under review) is shown as plain "reported" with no
 * candidate data – a possible match must never reach a family unverified.
 */
export function familyView(r: { id: string; personName: string; state: MissingState; verifiedBy?: MissingCase['verifiedBy']; foundShelterName?: string | null }): FamilyView {
  if ((r.state === 'verified' || r.state === 'announced') && r.verifiedBy) {
    return {
      id: r.id,
      personName: r.personName,
      status: r.state,
      message:
        r.state === 'announced'
          ? 'Verified and officially announced. Please contact the shelter.'
          : 'An administrator has verified that this person was found. Please contact the shelter.',
      found: { shelterName: r.foundShelterName ?? 'a relief shelter', verifiedBy: r.verifiedBy.name, verifiedAt: r.verifiedBy.at },
    };
  }
  return { id: r.id, personName: r.personName, status: 'reported', message: 'Your report has been received. The control room is searching. You will see an update here only after a person has been verified.' };
}

/* ------------------------------ matching ------------------------------ */

/** A person registered at a shelter / hospital – SAMPLE DATA (fictional people, no photos, no faces). */
export interface FoundPerson {
  id: string;
  name: string;
  approxAge: number | null;
  gender: 'female' | 'male' | 'other' | 'unknown';
  description: string;
  shelterId: string;
  shelterName: string;
  lat: number;
  lng: number;
  registeredAt: string;
  sample: true;
}

export interface MissingCandidate {
  foundPersonId: string;
  name: string;
  shelterId: string;
  shelterName: string;
  /** 0..1, 2 decimals */
  confidence: number;
  breakdown: { name: number; age: number; gender: number; description: number; location: number };
  evidence: string[];
  sample: true;
}

export const MATCH_WEIGHTS = { name: 0.45, age: 0.15, gender: 0.1, description: 0.15, location: 0.15 } as const;
export const MATCH_THRESHOLD = 0.5;
export const MATCHER_VERSION = 'match-1.0.0';

const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'with', 'of', 'in', 'on', 'at', 'to', 'is', 'was', 'wearing', 'has', 'her', 'his', 'she', 'he', 'years', 'old', 'about']);

export function normName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function bigrams(s: string): string[] {
  const t = ` ${s} `;
  const out: string[] = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
}

/** Sørensen–Dice on character bigrams, 0..1. */
export function nameSimilarity(a: string, b: string): number {
  const x = normName(a);
  const y = normName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const A = bigrams(x);
  const B = bigrams(y);
  const counts = new Map<string, number>();
  for (const g of A) counts.set(g, (counts.get(g) ?? 0) + 1);
  let inter = 0;
  for (const g of B) {
    const n = counts.get(g) ?? 0;
    if (n > 0) {
      inter++;
      counts.set(g, n - 1);
    }
  }
  return (2 * inter) / (A.length + B.length);
}

export function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Proposes candidates for one report. Deterministic; ADVISORY ONLY – a
 * candidate is a suggestion for an administrator, never a finding.
 */
export function matchCandidates(report: Pick<MissingReport, 'person' | 'lastSeen'>, registry: FoundPerson[], opts: { threshold?: number; max?: number } = {}): MissingCandidate[] {
  const threshold = opts.threshold ?? MATCH_THRESHOLD;
  const out: MissingCandidate[] = [];
  const descTokens = tokens(report.person.description ?? '');
  for (const f of registry) {
    const name = nameSimilarity(report.person.name, f.name);
    const age =
      report.person.age === undefined || f.approxAge === null ? 0.5 : Math.max(0, 1 - Math.min(Math.abs(report.person.age - f.approxAge), 20) / 20);
    const g = report.person.gender ?? 'unknown';
    const gender = g === 'unknown' || f.gender === 'unknown' ? 0.5 : g === f.gender ? 1 : 0;
    const description = jaccard(descTokens, tokens(f.description));
    let location = 0.5;
    let distTxt = 'last-seen place has no map position';
    if (report.lastSeen.lat !== undefined && report.lastSeen.lng !== undefined) {
      const d = distanceM({ lat: report.lastSeen.lat, lng: report.lastSeen.lng }, f);
      location = d <= 2000 ? 1 : d >= 15000 ? 0 : 1 - (d - 2000) / 13000;
      distTxt = `shelter is ${(d / 1000).toFixed(1)} km from where they were last seen`;
    }
    let score =
      MATCH_WEIGHTS.name * name + MATCH_WEIGHTS.age * age + MATCH_WEIGHTS.gender * gender + MATCH_WEIGHTS.description * description + MATCH_WEIGHTS.location * location;
    if (gender === 0) score *= 0.3; // a recorded gender mismatch is strong evidence against
    const confidence = r2(score);
    if (confidence < threshold) continue;
    out.push({
      foundPersonId: f.id,
      name: f.name,
      shelterId: f.shelterId,
      shelterName: f.shelterName,
      confidence,
      breakdown: { name: r2(name), age: r2(age), gender: r2(gender), description: r2(description), location: r2(location) },
      evidence: [
        `Registered at ${f.shelterName} (sample registry record ${f.id})`,
        `Name similarity ${Math.round(name * 100)} % ("${report.person.name}" vs "${f.name}")`,
        report.person.age !== undefined && f.approxAge !== null ? `Age ${report.person.age} reported vs about ${f.approxAge} registered` : 'Age not comparable',
        `Gender: reported ${g}, registered ${f.gender}`,
        f.description ? `Registry description: "${f.description}"` : 'No registry description',
        distTxt,
      ],
      sample: true,
    });
  }
  return out.sort((a, b) => b.confidence - a.confidence || (a.foundPersonId < b.foundPersonId ? -1 : 1)).slice(0, opts.max ?? 3);
}
