/**
 * Missing-person workflow on the server (§10.6). SAMPLE DATA ONLY.
 * Every state change goes through the shared `transition()` – the same pure
 * state machine the tests prove cannot skip a state – and is audit-logged.
 */
import {
  familyView,
  matchCandidates,
  MATCHER_VERSION,
  transition,
  WorkflowError,
  type FoundPerson,
  type MissingAction,
  type MissingCandidate,
  type MissingCase,
  type MissingReport,
  type MissingState,
  type VerifyInput,
} from '@rusq/shared';
import { HttpError, type Services } from './services.ts';

interface Row {
  id: string;
  server_id: string;
  reporter_id: string;
  data: string;
  via: string;
  state: MissingState;
  candidates: string;
  verified_by: string | null;
  reviewer_id: string | null;
  announced_at: string | null;
  received_at: string;
  updated_at: string;
}

export function foundRegistry(s: Services): FoundPerson[] {
  return (s.db.prepare('SELECT data FROM found_persons ORDER BY id').all() as { data: string }[]).map((r) => JSON.parse(r.data) as FoundPerson);
}

function getRow(s: Services, id: string): Row {
  const r = s.db.prepare('SELECT * FROM missing_reports WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw new HttpError(404, 'missing-person report not found');
  return r;
}

function toCase(r: Row): MissingCase {
  return { state: r.state, candidates: JSON.parse(r.candidates) as MissingCandidate[], verifiedBy: r.verified_by ? JSON.parse(r.verified_by) : null };
}

function save(s: Services, id: string, c: MissingCase, extra: { reviewerId?: string | null; announcedAt?: string | null } = {}) {
  s.db
    .prepare('UPDATE missing_reports SET state = ?, candidates = ?, verified_by = ?, reviewer_id = COALESCE(?, reviewer_id), announced_at = COALESCE(?, announced_at), updated_at = ? WHERE id = ?')
    .run(c.state, JSON.stringify(c.candidates), c.verifiedBy ? JSON.stringify(c.verifiedBy) : null, extra.reviewerId ?? null, extra.announcedAt ?? null, s.now().toISOString(), id);
}

/**
 * System step: propose sample-registry candidates for a report in state
 * "reported". Only moves the case to "candidate_found" – a suggestion for an
 * administrator, never a finding. Returns the number of candidates.
 */
export function proposeCandidates(s: Services, id: string): number {
  const r = getRow(s, id);
  if (r.state !== 'reported') return 0;
  const report = JSON.parse(r.data) as MissingReport;
  const cands = matchCandidates(report, foundRegistry(s));
  if (cands.length === 0) {
    s.audit('system', 'missing.match_none', id, { matcher: MATCHER_VERSION });
    return 0;
  }
  const next = transition(toCase(r), 'propose_candidates', { at: s.now().toISOString(), candidates: cands, actorRole: 'system' });
  save(s, id, next);
  s.audit('system', 'missing.candidates_proposed', id, { matcher: MATCHER_VERSION, candidates: cands.map((c) => ({ id: c.foundPersonId, confidence: c.confidence })) });
  return cands.length;
}

export function adminAction(
  s: Services,
  id: string,
  action: Exclude<MissingAction, 'propose_candidates'>,
  actor: { id: string; name: string; role: string },
  body: { candidateId?: string; checks?: Record<string, boolean>; note?: string },
) {
  const r = getRow(s, id);
  const at = s.now().toISOString();
  let verify: VerifyInput | undefined;
  if (action === 'verify') verify = { actorId: actor.id, actorName: actor.name, candidateId: body.candidateId ?? '', checks: body.checks ?? {}, note: body.note ?? '' };
  let next: MissingCase;
  try {
    next = transition(toCase(r), action, { at, verify, actorRole: actor.role });
  } catch (e) {
    if (e instanceof WorkflowError) throw new HttpError(409, e.message);
    throw e;
  }
  save(s, id, next, { reviewerId: action === 'start_review' ? actor.id : null, announcedAt: action === 'announce' ? at : null });
  s.audit(actor.id, `missing.${action}`, id, { from: r.state, to: next.state, note: body.note, candidateId: body.candidateId, checks: body.checks });
  return next;
}

/** Full detail – ADMIN ONLY. */
export function listCasesForAdmin(s: Services) {
  return (s.db.prepare('SELECT * FROM missing_reports ORDER BY received_at DESC').all() as unknown as Row[]).map((r) => ({
    id: r.id,
    serverId: r.server_id,
    report: JSON.parse(r.data) as MissingReport,
    via: r.via,
    state: r.state,
    candidates: JSON.parse(r.candidates) as MissingCandidate[],
    verifiedBy: r.verified_by ? JSON.parse(r.verified_by) : null,
    reviewerId: r.reviewer_id,
    announcedAt: r.announced_at,
    receivedAt: r.received_at,
    updatedAt: r.updated_at,
    // photos the family attached; "received" = the bytes are on the server (they may still be travelling)
    photos: ((JSON.parse(r.data) as MissingReport).photos ?? []).map((id) => ({ id, received: !!s.db.prepare('SELECT 1 FROM photos WHERE id = ?').get(id) })),
  }));
}

function shelterNameFor(s: Services, c: MissingCase): string | null {
  const id = c.verifiedBy?.candidateId;
  return c.candidates.find((x) => x.foundPersonId === id)?.shelterName ?? null;
}

/** What the reporting family sees (redacted before "verified"). */
export function familyCases(s: Services, reporterId: string) {
  return (s.db.prepare('SELECT * FROM missing_reports WHERE reporter_id = ? ORDER BY received_at DESC').all(reporterId) as unknown as Row[]).map((r) => {
    const c = toCase(r);
    const rep = JSON.parse(r.data) as MissingReport;
    return { ...familyView({ id: r.id, personName: rep.person.name, state: r.state, verifiedBy: c.verifiedBy, foundShelterName: shelterNameFor(s, c) }), serverId: r.server_id, receivedAt: r.received_at };
  });
}

/** Public announcements – only cases that were verified by a named admin AND announced. */
export function announcements(s: Services) {
  return (s.db.prepare("SELECT * FROM missing_reports WHERE state = 'announced' ORDER BY announced_at DESC").all() as unknown as Row[]).map((r) => {
    const c = toCase(r);
    const rep = JSON.parse(r.data) as MissingReport;
    return {
      id: r.id,
      personName: rep.person.name,
      shelterName: shelterNameFor(s, c),
      verifiedBy: c.verifiedBy?.name ?? null,
      announcedAt: r.announced_at,
      sample: true,
    };
  });
}
