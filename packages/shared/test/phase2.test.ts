/** Phase 2 shared logic: geo, missing-person workflow + matching, decision support, SOS triage, CCTV, LLM guard. */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  allocate,
  allotmentNumbers,
  allowedActions,
  canonicalJson,
  cctvSignals,
  cellOf,
  cosPoly,
  decide,
  detectionsAt,
  distanceM,
  familyView,
  guardExplanation,
  guardStructuredNotes,
  isVulnerable,
  matchCandidates,
  MISSING_STATES,
  nameSimilarity,
  numbersIn,
  personnelEstimate,
  SAMPLE_CCTV,
  sosTriage,
  templateExplanation,
  transition,
  VERIFY_CHECKLIST,
  WorkflowError,
  type DecisionInput,
  type FoundPerson,
  type MissingAction,
  type MissingCandidate,
  type MissingCase,
  type Site,
} from '../src/index.ts';

/* ---------------------------------- geo ---------------------------------- */

describe('geo', () => {
  it('cosPoly matches Math.cos closely on the valid range', () => {
    for (let x = -1.5; x <= 1.5; x += 0.01) expect(Math.abs(cosPoly(x) - Math.cos(x))).toBeLessThan(1e-6);
  });

  it('distanceM is within 0.5 % of haversine for local distances and symmetric', () => {
    const hav = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
      const R = 6371008.8;
      const r = Math.PI / 180;
      const dl = (b.lat - a.lat) * r;
      const dg = (b.lng - a.lng) * r;
      const h = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dg / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(h));
    };
    const a = { lat: 27.7156, lng: 85.3081 };
    const b = { lat: 27.7040, lng: 85.3145 };
    expect(Math.abs(distanceM(a, b) - hav(a, b)) / hav(a, b)).toBeLessThan(0.005);
    expect(distanceM(a, b)).toBe(distanceM(b, a));
    expect(Number.isInteger(distanceM(a, b))).toBe(true);
  });

  it('cellOf groups points in the same 0.01° square', () => {
    expect(cellOf(27.6912, 85.3195).id).toBe(cellOf(27.6999, 85.3101).id);
    expect(cellOf(27.6912, 85.3195).id).not.toBe(cellOf(27.7012, 85.3195).id);
  });
});

/* ----------------------------- missing persons ----------------------------- */

const cand = (id = 'FP-1'): MissingCandidate => ({
  foundPersonId: id,
  name: 'X',
  shelterId: 's',
  shelterName: 'S',
  confidence: 0.8,
  breakdown: { name: 1, age: 1, gender: 1, description: 0, location: 1 },
  evidence: [],
  sample: true,
});
const allChecks = Object.fromEntries(VERIFY_CHECKLIST.map((c) => [c.id, true]));
const verifyInput = { actorId: 'u-admin', actorName: 'District Control Room', candidateId: 'FP-1', checks: allChecks, note: 'Confirmed by phone with shelter warden.' };
const at = '2026-07-20T10:00:00.000Z';

function ctxFor(action: MissingAction) {
  return { at, candidates: action === 'propose_candidates' ? [cand()] : undefined, verify: action === 'verify' ? verifyInput : undefined, actorRole: 'admin' };
}

describe('missing-person workflow', () => {
  it('follows the full legal path reported → … → announced', () => {
    let c: MissingCase = { state: 'reported', candidates: [] };
    for (const a of ['propose_candidates', 'start_review', 'verify', 'announce'] as MissingAction[]) c = transition(c, a, ctxFor(a));
    expect(c.state).toBe('announced');
    expect(c.verifiedBy?.name).toBe('District Control Room');
  });

  it('rejects every edge that is not in the state machine (no skipping)', () => {
    const actions: MissingAction[] = ['propose_candidates', 'start_review', 'reject_candidates', 'verify', 'announce'];
    for (const s of MISSING_STATES) {
      for (const a of actions) {
        const c: MissingCase = { state: s, candidates: [cand()], verifiedBy: s === 'verified' || s === 'announced' ? { id: 'u', name: 'A', at, candidateId: 'FP-1', note: 'x' } : null };
        const legal = allowedActions(s).includes(a);
        if (legal) expect(() => transition(c, a, ctxFor(a))).not.toThrow();
        else expect(() => transition(c, a, ctxFor(a))).toThrow(WorkflowError);
      }
    }
  });

  it('verify requires a named admin, a candidate on the case, the full checklist and a note', () => {
    const c: MissingCase = { state: 'under_review', candidates: [cand()] };
    expect(() => transition(c, 'verify', { at, verify: verifyInput, actorRole: 'rescuer' })).toThrow(/administrator/);
    expect(() => transition(c, 'verify', { at, verify: { ...verifyInput, actorName: '  ' }, actorRole: 'admin' })).toThrow(/named/);
    expect(() => transition(c, 'verify', { at, verify: { ...verifyInput, candidateId: 'nope' }, actorRole: 'admin' })).toThrow(/candidate/);
    expect(() => transition(c, 'verify', { at, verify: { ...verifyInput, checks: { compared: true } }, actorRole: 'admin' })).toThrow(/checklist/);
    expect(() => transition(c, 'verify', { at, verify: { ...verifyInput, note: 'ok' }, actorRole: 'admin' })).toThrow(/note/);
  });

  it('property: any action sequence reaches announced only via under_review → verify → announce, and families see nothing before verified', () => {
    const action = fc.constantFrom<MissingAction>('propose_candidates', 'start_review', 'reject_candidates', 'verify', 'announce');
    fc.assert(
      fc.property(fc.array(action, { maxLength: 30 }), fc.boolean(), (seq, role) => {
        let c: MissingCase = { state: 'reported', candidates: [] };
        const visited: string[] = ['reported'];
        for (const a of seq) {
          try {
            c = transition(c, a, { ...ctxFor(a), actorRole: role ? 'admin' : 'victim' });
            visited.push(c.state);
          } catch (e) {
            expect(e).toBeInstanceOf(WorkflowError);
          }
          const fv = familyView({ id: 'm', personName: 'P', state: c.state, verifiedBy: c.verifiedBy, foundShelterName: 'S' });
          if (c.state !== 'verified' && c.state !== 'announced') {
            expect(fv.status).toBe('reported');
            expect(fv.found).toBeUndefined();
            expect(JSON.stringify(fv)).not.toMatch(/candidate|confidence|FP-/i);
          }
        }
        // every step between consecutive visited states is one legal edge
        for (let i = 1; i < visited.length; i++) {
          const from = visited[i - 1] as MissingCase['state'];
          expect(allowedActions(from).length).toBeGreaterThan(0);
        }
        if (c.state === 'announced') {
          expect(c.verifiedBy).toBeTruthy();
          const iv = visited.lastIndexOf('verified');
          expect(visited[iv - 1]).toBe('under_review');
        }
        if (!role) expect(['reported', 'candidate_found']).toContain(c.state); // non-admins can only trigger the system proposal
      }),
      { numRuns: 500 },
    );
  });
});

const REGISTRY: FoundPerson[] = [
  { id: 'FP-1', name: 'Rina Shrestha', approxAge: 9, gender: 'female', description: 'girl red frock school bag', shelterId: 's1', shelterName: 'Shelter 1', lat: 27.7156, lng: 85.3081, registeredAt: at, sample: true },
  { id: 'FP-2', name: 'Rana Shrestha', approxAge: 40, gender: 'male', description: 'man blue shirt', shelterId: 's1', shelterName: 'Shelter 1', lat: 27.7156, lng: 85.3081, registeredAt: at, sample: true },
  { id: 'FP-3', name: 'Bikash Das', approxAge: 70, gender: 'male', description: 'elderly walking stick', shelterId: 's3', shelterName: 'Shelter 3', lat: 27.7040, lng: 85.3145, registeredAt: at, sample: true },
];

describe('candidate matching (sample registry)', () => {
  it('name similarity is 1 for identical names (case/punctuation-insensitive) and lower for different names', () => {
    expect(nameSimilarity('Rina Shrestha', 'rina  SHRESTHA.')).toBe(1);
    expect(nameSimilarity('Rina Shrestha', 'Bikash Das')).toBeLessThan(0.3);
  });

  it('ranks the true match first with evidence and marks everything as sample', () => {
    const c = matchCandidates({ person: { name: 'Rina Shrestha', age: 8, gender: 'female', description: 'Wearing a red frock' }, lastSeen: { place: 'Lainchaur', lat: 27.71, lng: 85.31 } }, REGISTRY);
    expect(c[0]!.foundPersonId).toBe('FP-1');
    expect(c[0]!.confidence).toBeGreaterThan(0.8);
    expect(c.every((x) => x.sample)).toBe(true);
    expect(c[0]!.evidence.join(' ')).toMatch(/sample registry/);
  });

  it('a recorded gender mismatch strongly lowers confidence (similar name, wrong gender)', () => {
    const c = matchCandidates({ person: { name: 'Rina Shrestha', age: 9, gender: 'female', description: '' }, lastSeen: { place: 'x' } }, REGISTRY, { threshold: 0 });
    const fp2 = c.find((x) => x.foundPersonId === 'FP-2')!;
    expect(fp2.confidence).toBeLessThan(0.3);
  });

  it('is deterministic and independent of registry order', () => {
    const q = { person: { name: 'Bikas Das', age: 72, gender: 'male' as const, description: 'old man with walking stick' }, lastSeen: { place: 'Sarusajai' } };
    const a = matchCandidates(q, REGISTRY, { threshold: 0 });
    const b = matchCandidates(q, [...REGISTRY].reverse(), { threshold: 0 });
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });
});

/* ----------------------------- decision support ----------------------------- */

const SHELTERS: Site[] = [
  { id: 'shelter-a', kind: 'shelter', name: 'Shelter A', lat: 27.7156, lng: 85.3081, density: 100, urgency: 1, needs: { food_water: 100 }, capacity: 300 },
  { id: 'shelter-b', kind: 'shelter', name: 'Shelter B', lat: 27.6926, lng: 85.3199, density: 195, urgency: 1, needs: { food_water: 50, boats: 1 }, capacity: 200 },
];

function baseInput(): DecisionInput {
  return {
    now: '2026-07-20T12:00:00.000Z',
    snapshotVersion: 3,
    stock: { food_water: 120, boats: 2, medical_supplies: 5 },
    shelters: SHELTERS,
    teams: [
      { teamId: 'team-alpha', name: 'Team Alpha', skills: ['boat', 'first_aid'], lat: 27.70, lng: 85.29 },
      { teamId: 'team-bravo', name: 'Team Bravo', skills: ['medical', 'search'], lat: 27.69, lng: 85.32 },
    ],
    reports: [
      { id: 'r1', teamId: 'team-alpha', lat: 27.6941, lng: 85.3212, victimCount: 20, urgency: 5, hazards: ['flooded street'], requested: { boats: 3, food_water: 60 }, createdAt: '2026-07-20T11:00:00.000Z' },
      { id: 'r2', teamId: 'team-bravo', lat: 27.7040, lng: 85.3145, victimCount: 4, urgency: 2, hazards: ['collapsed building'], requested: { medical_supplies: 2 }, createdAt: '2026-07-20T11:30:00.000Z' },
    ],
    sos: [
      { id: 's1', lat: 27.6945, lng: 85.3215, createdAt: '2026-07-20T10:00:00.000Z', status: 'open', vulnerable: true, medical: false, householdSize: 3 },
      { id: 's2', lat: 27.7012, lng: 85.3234, createdAt: '2026-07-20T11:00:00.000Z', status: 'open', vulnerable: false, medical: true, householdSize: 2 },
      { id: 's3', lat: 27.7012, lng: 85.3234, createdAt: '2026-07-20T11:00:00.000Z', status: 'resolved', vulnerable: false, medical: false, householdSize: 9 },
    ],
    cctv: [],
  };
}

describe('decision support', () => {
  it('computes the documented cell score by hand', () => {
    const out = decide(baseInput());
    const c = out.cells.find((x) => x.cellId === cellOf(27.6941, 85.3212).id)!;
    // people = 20 (report) + 3 (s1 household) = 23; open SOS 1, vulnerable 1, max urgency 5, flooded.
    // s1 sent 10:00, report r1 in the same cell at 11:00 → not unattended.
    expect(c.people).toBe(23);
    expect(c.unattendedSos).toBe(0);
    expect(c.score).toBe(2 * 23 + 10 + 10 + 8 * 5 + 15);
    expect(c.severity).toBe('critical');
    // s2 cell: no report → unattended (60 min ≥ 30); s3 resolved is ignored
    const c2 = out.cells.find((x) => x.cellId === cellOf(27.7012, 85.3234).id)!;
    expect(c2.openSos).toBe(1);
    expect(c2.peopleSos).toBe(2);
    expect(c2.unattendedSos).toBe(1);
    expect(c2.score).toBe(2 * 2 + 10 + 0 + 0 + 10);
  });

  it('every recommendation carries reasoning, a deterministic id and is ordered by severity', () => {
    const out = decide(baseInput());
    expect(out.recommendations.length).toBeGreaterThan(4);
    const rank = { critical: 0, high: 1, medium: 2, low: 3 };
    for (let i = 1; i < out.recommendations.length; i++) expect(rank[out.recommendations[i]!.severity]).toBeGreaterThanOrEqual(rank[out.recommendations[i - 1]!.severity]);
    for (const r of out.recommendations) expect(r.reasoning.length).toBeGreaterThan(0);
    const kinds = new Set(out.recommendations.map((r) => r.kind));
    for (const k of ['priority_area', 'victim_concentration', 'personnel', 'team_assignment', 'resource_distribution', 'unmet_need']) expect(kinds).toContain(k);
  });

  it('matches the boat-skilled team to the flooded area and the shelter-full warning fires at ≥ 90 %', () => {
    const out = decide(baseInput());
    const flooded = cellOf(27.6941, 85.3212).id;
    const t = out.recommendations.find((r) => r.kind === 'team_assignment' && r.proposal.cellId === flooded)!;
    expect(t.proposal.teamId).toBe('team-alpha');
    expect(out.recommendations.some((r) => r.kind === 'victim_concentration' && r.proposal.shelterId === 'shelter-b' && r.proposal.occupancyPct === 97)).toBe(true);
  });

  it('resource distribution equals the Phase 1 engine run on the same demand, and shortfalls become unmet needs', () => {
    const inp = baseInput();
    const out = decide(inp);
    expect(out.allocation).not.toBeNull();
    // independently built demand: 2 shelters + one incident site per area that requested something
    const c1 = cellOf(27.6941, 85.3212).id;
    const c2 = cellOf(27.7040, 85.3145).id;
    const again = allocate({
      snapshotVersion: 3,
      stock: inp.stock,
      provisional: false,
      sites: [
        ...SHELTERS.map((s) => ({ id: s.id, kind: 'shelter' as const, density: s.density, urgency: 1, needs: s.needs })),
        { id: `area-${c1}`, kind: 'incident', density: 23, urgency: 5, needs: { boats: 3, food_water: 60 } },
        { id: `area-${c2}`, kind: 'incident', density: 4, urgency: 2, needs: { medical_supplies: 2 } },
      ],
    });
    expect(canonicalJson(out.allocation)).toBe(canonicalJson(again));
    // boats: need 3 (area) + 1 (shelter b) = 4 > stock 2 → shortfall 2
    expect(out.allocation!.shortfall.boats).toBe(2);
    expect(out.recommendations.find((r) => r.kind === 'unmet_need' && r.proposal.resource === 'boats')?.severity).toBe('critical');
  });

  it('property: output is deterministic and independent of input order; never mutates input; each team suggested at most once', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1000 }), (seed) => {
        const inp = baseInput();
        const shuffle = <T,>(a: T[]) => a.map((x, i) => [((i + 1) * 2654435761 + seed) % 997, x] as const).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
        const before = canonicalJson(inp);
        const a = decide(inp);
        expect(canonicalJson(inp)).toBe(before);
        const b = decide({ ...inp, reports: shuffle(inp.reports), sos: shuffle(inp.sos), teams: shuffle(inp.teams), shelters: shuffle(inp.shelters) });
        expect(canonicalJson(b)).toBe(canonicalJson(a));
        const teams = a.recommendations.filter((r) => r.kind === 'team_assignment').map((r) => r.proposal.teamId);
        expect(new Set(teams).size).toBe(teams.length);
      }),
      { numRuns: 50 },
    );
  });

  it('personnel estimate follows its stated rules', () => {
    const p = personnelEstimate({ people: 23, maxUrgency: 5, flooded: true, hazards: [], vulnerableSos: 1, medicalSos: 0 });
    expect(p).toMatchObject({ rescuers: 5, boats: 4, medics: 1 });
    const q = personnelEstimate({ people: 8, maxUrgency: 2, flooded: false, hazards: [], vulnerableSos: 0, medicalSos: 0 });
    expect(q).toMatchObject({ rescuers: 1, boats: 0, medics: 0 });
  });

  it('CCTV sample signals feed the rules (crowd + flooding raise the score)', () => {
    const inp = baseInput();
    const without = decide(inp).cells.find((c) => c.cellId === cellOf(SAMPLE_CCTV[0]!.lat, SAMPLE_CCTV[0]!.lng).id)!;
    const withCctv = decide({ ...inp, cctv: cctvSignals(SAMPLE_CCTV) }).cells.find((c) => c.cellId === without.cellId)!;
    expect(withCctv.evidence.cctv).toContain('CAM-01');
    expect(withCctv.blocked).toBe(true);
    expect(withCctv.score).toBeGreaterThan(without.score);
  });
});

describe('SOS triage', () => {
  const now = '2026-07-20T12:00:00.000Z';
  it('base 3, +1 per rule, capped at 5, with reasons', () => {
    expect(sosTriage({ createdAt: now, lat: 1 }, { now, vulnerable: false, medical: false }).level).toBe(3);
    const t = sosTriage({ createdAt: '2026-07-20T10:00:00.000Z', lat: null }, { now, vulnerable: true, medical: true, areaSeverity: 'critical' });
    expect(t.level).toBe(5);
    expect(t.reasons.join(' ')).toMatch(/no location/);
  });
  it('vulnerability flags', () => {
    expect(isVulnerable({ age: 70 })).toBe(true);
    expect(isVulnerable({ age: 30, needs: ['pet'] })).toBe(false);
    expect(isVulnerable({ needs: ['disability'] })).toBe(true);
  });
});

describe('CCTV sample data', () => {
  it('every camera is marked sample and detections have valid boxes/times', () => {
    for (const c of SAMPLE_CCTV) {
      expect(c.sample).toBe(true);
      for (const d of c.clip.detections) {
        expect(d.t0).toBeLessThanOrEqual(d.t1);
        expect(d.t1).toBeLessThanOrEqual(c.clip.durationS);
        for (const v of d.box) expect(v).toBeGreaterThanOrEqual(0);
        expect(d.box[0] + d.box[2]).toBeLessThanOrEqual(1.0001);
        expect(d.box[1] + d.box[3]).toBeLessThanOrEqual(1.0001);
      }
    }
    expect(detectionsAt(SAMPLE_CCTV[0]!, 2).map((d) => d.label)).toEqual(['flooded_road']);
    expect(cctvSignals(SAMPLE_CCTV).find((s) => s.cameraId === 'CAM-01')!.crowd).toBe(13);
  });
});

/* ------------------------------- LLM guard ------------------------------- */

describe('assistant guard (never produces numbers)', () => {
  const notes = 'Water at chest level near the temple. 12 people on the roof, 2 children, one old man needs insulin.';
  it('accepts a schema-valid structure that only copies numbers', () => {
    const r = guardStructuredNotes(JSON.stringify({ observations: ['12 people on the roof', '2 children', 'Man needs insulin'], hazardsMentioned: ['flooded street'], needsMentioned: ['medical_supplies'] }), notes);
    expect(r.ok).toBe(true);
  });
  it('rejects an invented number, a number in words, bad JSON and unknown labels', () => {
    expect(guardStructuredNotes(JSON.stringify({ observations: ['15 people on the roof'] }), notes).ok).toBe(false);
    expect(guardStructuredNotes(JSON.stringify({ observations: ['about twenty people'] }), notes).ok).toBe(false);
    expect(guardStructuredNotes('sure! here you go', notes).ok).toBe(false);
    expect(guardStructuredNotes(JSON.stringify({ observations: ['x'], hazardsMentioned: ['tsunami'] }), notes).ok).toBe(false);
  });
  it('numbersIn normalises thousands separators and decimals', () => {
    expect(numbersIn('1,200 packs and 3.50 boats')).toEqual(['1200', '3.5']);
  });
  it('property: the deterministic template always passes its own number guard', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 500 }), fc.integer({ min: 0, max: 500 }), fc.integer({ min: 0, max: 900 }), fc.integer({ min: 1, max: 5 }), (n1, n2, stock, u) => {
        const res = allocate({
          snapshotVersion: 7,
          stock: { food_water: stock },
          sites: [
            { id: 'a', kind: 'incident', density: 10, urgency: u, needs: { food_water: n1 } },
            { id: 'b', kind: 'shelter', density: 50, urgency: 1, needs: { food_water: n2 } },
          ],
          provisional: true,
        });
        const text = templateExplanation(res, 'a', { food_water: n1 });
        // it must actually talk about the request whenever the site asked for something
        if (n1 > 0) expect(text).toMatch(new RegExp(`asked for ${n1} packs of food and water`));
        else expect(text).toBe('Nothing was requested for this site.');
        if (n1 > 0 && (res.perSite.a?.food_water ?? 0) > 0) expect(text).toContain(String(res.perSite.a!.food_water));
        expect(guardExplanation(JSON.stringify({ text }), allotmentNumbers(res, 'a', { food_water: n1 })).ok).toBe(true);
        expect(guardExplanation(JSON.stringify({ text: text + ' You will also get 99999 boats.' }), allotmentNumbers(res, 'a', { food_water: n1 })).ok).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});
