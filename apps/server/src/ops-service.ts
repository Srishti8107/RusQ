/**
 * Phase 2 operations: profiles, shelters, SOS monitor, decision support,
 * team tasks, dashboard aggregates, staff accounts. Thin over the shared
 * pure modules (decision.ts, profile.ts, cctv.ts).
 */
import { randomUUID } from 'node:crypto';
import {
  cctvSignals,
  decide,
  distanceM,
  hasMedicalNeed,
  isActive,
  isVulnerable,
  RESOURCE_KEYS,
  SAMPLE_CCTV,
  sosTriage,
  type DecisionInput,
  type DecisionOutput,
  type DsTeam,
  type FieldReport,
  type Profile,
  type Recommendation,
  type ResourceQty,
  type Site,
  type SosOpsStatus,
  type StaffAccount,
} from '@rusq/shared';
import { hashPassword } from './auth.ts';
import { kvGet, kvSet } from './db.ts';
import { HttpError, type Services } from './services.ts';
import { listAssignments } from './assignment-service.ts';
import { areaContext, inRegion, nearestFacility } from './nepal/context.ts';

/* ------------------------------ profiles ------------------------------ */

export function getProfile(s: Services, userId: string): Profile | null {
  const r = s.db.prepare('SELECT profile FROM users WHERE id = ?').get(userId) as { profile: string } | undefined;
  if (!r) return null;
  const p = JSON.parse(r.profile) as Partial<Profile>;
  return p.name ? (p as Profile) : null;
}

/** Last write wins by the client's `updatedAt` (the phone may save offline and upload later). */
export function saveProfile(s: Services, userId: string, p: Profile): { savedAt: string; applied: boolean } {
  const cur = getProfile(s, userId);
  if (cur && cur.updatedAt > p.updatedAt) return { savedAt: cur.updatedAt, applied: false };
  s.db.prepare('UPDATE users SET profile = ?, name = ? WHERE id = ?').run(JSON.stringify(p), p.name, userId);
  s.audit(userId, 'profile.saved', userId, { contacts: p.contacts.length });
  return { savedAt: p.updatedAt, applied: true };
}

/* ------------------------------ shelters ------------------------------ */

export interface ShelterDetails {
  address?: string;
  phone?: string;
  facilities?: string[];
}

export function shelters(s: Services) {
  const details = JSON.parse(kvGet(s.db, 'shelterDetails') ?? '{}') as Record<string, ShelterDetails>;
  const snap = s.latestSnapshot();
  return {
    version: snap?.version ?? 0,
    updatedAt: snap?.createdAt ?? s.now().toISOString(),
    shelters: s
      .sites()
      .filter((x) => x.kind === 'shelter')
      .map((x) => ({
        id: x.id,
        name: x.name ?? x.id,
        lat: x.lat,
        lng: x.lng,
        capacity: x.capacity ?? null,
        occupancy: x.density,
        free: x.capacity ? Math.max(0, x.capacity - x.density) : null,
        address: details[x.id]?.address ?? '',
        phone: details[x.id]?.phone ?? '',
        facilities: details[x.id]?.facilities ?? [],
        sample: true,
      })),
  };
}

/* ------------------------------ teams ------------------------------ */

export function teamName(teamId: string): string {
  return teamId
    .split('-')
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}

export function teams(s: Services): DsTeam[] {
  const rows = s.db.prepare("SELECT team_id, skills FROM users WHERE role = 'rescuer' AND team_id IS NOT NULL AND disabled = 0 ORDER BY team_id").all() as {
    team_id: string;
    skills: string;
  }[];
  const by = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = by.get(r.team_id) ?? new Set<string>();
    for (const k of JSON.parse(r.skills) as string[]) set.add(k);
    by.set(r.team_id, set);
  }
  // team position = its most recent field report (the only position the server has)
  const last = new Map<string, { lat: number; lng: number }>();
  for (const r of s.listReports()) if (!last.has(r.teamId)) last.set(r.teamId, { lat: r.lat, lng: r.lng });
  return [...by.entries()].map(([teamId, skills]) => ({ teamId, name: teamName(teamId), skills: [...skills].sort(), lat: last.get(teamId)?.lat ?? null, lng: last.get(teamId)?.lng ?? null }));
}

/* --------------------------- decision support --------------------------- */

export function cctvEnabled(s: Services): boolean {
  return kvGet(s.db, 'cctvEnabled') !== '0';
}

export function setCctvEnabled(s: Services, on: boolean, actor: string) {
  kvSet(s.db, 'cctvEnabled', on ? '1' : '0');
  s.audit(actor, on ? 'cctv.sample_enabled' : 'cctv.sample_disabled', 'cctv');
}

export function decisionInput(s: Services): DecisionInput {
  return {
    now: s.now().toISOString(),
    snapshotVersion: s.latestSnapshot()?.version ?? 1,
    stock: s.liveStock(),
    shelters: s.sites().filter((x) => x.kind === 'shelter'),
    teams: teams(s),
    cctv: cctvEnabled(s) ? cctvSignals(SAMPLE_CCTV) : [],
    areaContext: areaContext(),
    reports: s.listReports().map((r) => ({
      id: r.id,
      serverId: r.serverId,
      teamId: r.teamId,
      lat: r.lat,
      lng: r.lng,
      victimCount: r.humanFinal.victimCount,
      urgency: r.humanFinal.urgency,
      hazards: r.humanFinal.hazards,
      requested: r.humanFinal.requested,
      createdAt: r.createdAt,
    })),
    sos: s.listSos().map((x) => ({
      id: x.id,
      serverId: x.serverId,
      lat: x.lat,
      lng: x.lng,
      createdAt: x.createdAt,
      status: x.status as SosOpsStatus,
      vulnerable: isVulnerable(x.profile),
      medical: hasMedicalNeed(x.profile),
      householdSize: x.profile?.householdSize ?? 1,
    })),
  };
}

export function decisions(s: Services): { output: DecisionOutput; decided: Record<string, { decision: string; actorName: string; note: string | null; decidedAt: string }>; history: unknown[] } {
  const output = decide(decisionInput(s));
  const rows = s.db.prepare('SELECT rec_id, kind, decision, actor_name, note, rec, decided_at FROM rec_decisions ORDER BY decided_at DESC').all() as Record<string, string | null>[];
  const decided: Record<string, { decision: string; actorName: string; note: string | null; decidedAt: string }> = {};
  for (const r of rows) decided[r.rec_id!] = { decision: r.decision!, actorName: r.actor_name!, note: r.note ?? null, decidedAt: r.decided_at! };
  return {
    output,
    decided,
    history: rows.map((r) => ({ recId: r.rec_id, kind: r.kind, decision: r.decision, actorName: r.actor_name, note: r.note, decidedAt: r.decided_at, rec: JSON.parse(r.rec!) })),
  };
}

/**
 * Approve / reject one recommendation. It must be one the rules produce RIGHT
 * NOW (the id contains a content hash – if the situation changed, the admin is
 * asked to look again). The recommendation is stored exactly as shown.
 */
export function decideRecommendation(s: Services, recId: string, decision: 'approve' | 'reject', actor: { id: string; name: string }, note?: string): Recommendation {
  const existing = s.db.prepare('SELECT decision FROM rec_decisions WHERE rec_id = ?').get(recId) as { decision: string } | undefined;
  if (existing) throw new HttpError(409, `already ${existing.decision === 'approve' ? 'approved' : 'rejected'}`);
  const rec = decide(decisionInput(s)).recommendations.find((r) => r.id === recId);
  if (!rec) throw new HttpError(409, 'this recommendation is out of date – the situation changed. Refresh and review the new one.');
  s.db
    .prepare('INSERT INTO rec_decisions (rec_id, kind, decision, actor_id, actor_name, note, rec, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(recId, rec.kind, decision, actor.id, actor.name, note ?? null, JSON.stringify(rec), s.now().toISOString());
  s.audit(actor.id, `recommendation.${decision === 'approve' ? 'approved' : 'rejected'}`, recId, { kind: rec.kind, title: rec.title, note });
  return rec;
}

/** Approved team assignments for one team (what the rescuer sees as "tasks"). */
export function teamTasks(s: Services, teamId: string | null) {
  if (!teamId) return [];
  const rows = s.db.prepare("SELECT rec, actor_name, note, decided_at FROM rec_decisions WHERE kind = 'team_assignment' AND decision = 'approve' ORDER BY decided_at DESC").all() as Record<string, string | null>[];
  const tasks = rows
    .map((r) => ({ rec: JSON.parse(r.rec!) as Recommendation, approvedBy: r.actor_name, note: r.note, approvedAt: r.decided_at }))
    .filter((t) => t.rec.proposal.teamId === teamId)
    .map((t) => ({ id: t.rec.id, title: t.rec.title, summary: t.rec.summary, location: t.rec.location, reasoning: t.rec.reasoning, approvedBy: t.approvedBy, approvedAt: t.approvedAt, note: t.note }));
  const sos = s
    .listSos()
    .filter((x) => x.assignedTeam === teamId && x.status !== 'resolved')
    .map((x) => ({ serverId: x.serverId, lat: x.lat, lng: x.lng, name: x.profile?.name ?? 'Unknown', contacts: x.profile?.contacts ?? [], phone: x.profile?.phone ?? null, note: x.opsNote, createdAt: x.createdAt }));
  return { tasks, sos, assignments: listAssignments(s, teamId).filter(isActive) };
}

/* ------------------------------ SOS monitor ------------------------------ */

export const SOS_STATUSES = ['open', 'acknowledged', 'assigned', 'resolved'] as const;

export function sosMonitor(s: Services) {
  const out = decide(decisionInput(s));
  const sevByCell = new Map(out.cells.map((c) => [c.cellId, c.severity]));
  const now = s.now().toISOString();
  return s.listSos().map((x) => {
    const vulnerable = isVulnerable(x.profile);
    const medical = hasMedicalNeed(x.profile);
    const cell = x.lat !== null && x.lng !== null ? out.cells.find((c) => c.evidence.sos.includes(x.serverId)) : undefined;
    const triage = sosTriage(x, { now, vulnerable, medical, areaSeverity: cell ? sevByCell.get(cell.cellId) : null });
    return {
      ...x,
      triage: x.status === 'resolved' ? { level: 1, reasons: ['resolved'] } : triage,
      delayMs: Date.parse(x.receivedAt) - Date.parse(x.createdAt),
      areaSeverity: cell?.severity ?? null,
      areaContext: cell?.context ?? null,
      // real OpenStreetMap hospital nearest to the person (sample region only)
      nearestHospital: x.lat !== null && x.lng !== null && inRegion({ lat: x.lat, lng: x.lng }) ? nearestFacility({ lat: x.lat, lng: x.lng }) : null,
    };
  });
}

export function setSosStatus(s: Services, id: string, status: SosOpsStatus, actor: string, opts: { teamId?: string | null; note?: string }) {
  const row = s.db.prepare('SELECT server_id, assigned_team FROM sos WHERE id = ?').get(id) as { server_id: string; assigned_team: string | null } | undefined;
  if (!row) throw new HttpError(404, 'SOS not found');
  if (status === 'assigned' && !opts.teamId) throw new HttpError(400, 'choose a team to assign');
  if (status === 'assigned' && !teams(s).some((t) => t.teamId === opts.teamId)) throw new HttpError(400, `unknown team ${opts.teamId}`);
  // assigned → that team; resolved → keep the team for the record; open/acknowledged → no team
  const team = status === 'assigned' ? opts.teamId! : status === 'resolved' ? row.assigned_team : null;
  s.db
    .prepare('UPDATE sos SET status = ?, assigned_team = ?, ops_note = ?, status_by = ?, status_at = ? WHERE id = ?')
    .run(status, team, opts.note ?? null, actor, s.now().toISOString(), id);
  s.audit(actor, `sos.${status}`, id, { serverId: row.server_id, teamId: opts.teamId, note: opts.note });
}

/** The person's own SOS as the control room sees them (for the victim's status screen). */
export function mySos(s: Services, userId: string) {
  return s
    .listSos()
    .filter((x) => x.userId === userId)
    .map((x) => ({ id: x.id, serverId: x.serverId, status: x.status, assignedTeam: x.assignedTeam ? teamName(x.assignedTeam) : null, statusAt: x.statusAt, receivedAt: x.receivedAt }));
}

/* ------------------------------ dashboard ------------------------------ */

function sumQty(list: ResourceQty[]): ResourceQty {
  const out: ResourceQty = {};
  for (const q of list) for (const k of RESOURCE_KEYS) if (q[k]) out[k] = (out[k] ?? 0) + q[k]!;
  return out;
}

export function dashboard(s: Services) {
  const sos = s.listSos();
  const reports = s.listReports();
  const d = decide(decisionInput(s));
  const allot = s.allAllotments();
  const approved = sumQty(allot.filter((a) => a.status === 'approved').map((a) => (a.approvedClaim ?? {}) as ResourceQty));
  const requested = sumQty(reports.map((r) => r.humanFinal.requested));
  // analytics: SOS + reports per hour (last 24 h, by receivedAt)
  const nowMs = s.now().getTime();
  const hours = Array.from({ length: 24 }, (_, i) => ({ hourStart: new Date(Math.floor(nowMs / 3600000) * 3600000 - (23 - i) * 3600000).toISOString(), sos: 0, reports: 0 }));
  const bucket = (iso: string) => 23 - Math.floor((Math.floor(nowMs / 3600000) * 3600000 - Math.floor(Date.parse(iso) / 3600000) * 3600000) / 3600000);
  for (const x of sos) {
    const b = bucket(x.receivedAt);
    if (b >= 0 && b < 24) hours[b]!.sos++;
  }
  for (const r of reports) {
    const b = bucket(r.receivedAt!);
    if (b >= 0 && b < 24) hours[b]!.reports++;
  }
  const byHazard: Record<string, number> = {};
  for (const r of reports) for (const h of r.humanFinal.hazards) byHazard[h] = (byHazard[h] ?? 0) + 1;
  const viaRelay = sos.filter((x) => x.via === 'relay').length + reports.filter((r) => r.via === 'relay').length;
  const delays = sos.map((x) => Date.parse(x.receivedAt) - Date.parse(x.createdAt)).sort((a, b) => a - b);

  return {
    generatedAt: s.now().toISOString(),
    counts: {
      sosTotal: sos.length,
      sosOpen: sos.filter((x) => x.status === 'open').length,
      sosInProgress: sos.filter((x) => x.status === 'acknowledged' || x.status === 'assigned').length,
      sosResolved: sos.filter((x) => x.status === 'resolved').length,
      reports: reports.length,
      peopleReported: reports.reduce((n, r) => n + r.humanFinal.victimCount, 0),
      photos: s.count('photos'),
      missingOpen: (s.db.prepare("SELECT COUNT(*) AS n FROM missing_reports WHERE state NOT IN ('announced')").get() as { n: number }).n,
      pendingAllotments: allot.filter((a) => a.status === 'pending').length,
      openConflicts: s.conflicts('open').length,
      criticalAreas: d.cells.filter((c) => c.severity === 'critical').length,
      viaRelay,
    },
    sosDelay: { medianMs: delays.length ? delays[Math.floor(delays.length / 2)]! : null, maxMs: delays.at(-1) ?? null },
    resources: RESOURCE_KEYS.map((k) => ({ resource: k, stock: s.liveStock()[k] ?? 0, requested: requested[k] ?? 0, approved: approved[k] ?? 0, shortfall: d.allocation?.shortfall[k] ?? 0 })),
    byHazard,
    timeline: hours,
    cells: d.cells,
    shelters: shelters(s).shelters,
    map: {
      sos: sos.map((x) => ({ id: x.id, serverId: x.serverId, lat: x.lat, lng: x.lng, status: x.status, name: x.profile?.name ?? '' })),
      reports: reports.map((r) => ({ id: r.id, serverId: r.serverId, lat: r.lat, lng: r.lng, urgency: r.humanFinal.urgency, victims: r.humanFinal.victimCount, hazards: r.humanFinal.hazards, teamId: r.teamId })),
      cctv: cctvEnabled(s) ? SAMPLE_CCTV.map((c) => ({ id: c.id, name: c.name, lat: c.lat, lng: c.lng })) : [],
    },
  };
}

/** Comparison of resource requests across locations (reports grouped by area). */
export function reportsView(s: Services) {
  const reports = s.listReports();
  const shel = s.sites().filter((x) => x.kind === 'shelter');
  return reports.map((r) => {
    const near = shel.map((x) => ({ x, d: distanceM(r, x) })).sort((a, b) => a.d - b.d)[0];
    const photos = (s.db.prepare('SELECT id, server_id FROM photos WHERE report_id = ?').all(r.id) as { id: string; server_id: string }[]).map((p) => p.id);
    return { ...(r as FieldReport & { serverId: string; via: string; receivedAt: string }), photosReceived: photos, nearestShelter: near ? { id: near.x.id, name: near.x.name, distanceM: near.d } : null };
  });
}

/* ------------------------------ staff accounts ------------------------------ */

export function listUsers(s: Services) {
  return (s.db.prepare('SELECT id, username, role, name, team_id, skills, profile, created_at, disabled FROM users ORDER BY role, username').all() as Record<string, string | number | null>[]).map((u) => {
    const p = JSON.parse(u.profile as string) as Partial<Profile>;
    return {
      id: u.id,
      username: u.username,
      role: u.role,
      name: u.name,
      teamId: u.team_id,
      skills: JSON.parse(u.skills as string),
      hasProfile: !!p.name,
      contacts: p.contacts?.length ?? 0,
      createdAt: u.created_at,
      disabled: !!u.disabled,
    };
  });
}

export function createStaff(s: Services, a: StaffAccount, actor: string) {
  if (a.role === 'rescuer' && !a.teamId) throw new HttpError(400, 'a rescuer needs a team id (for example team-delta)');
  const taken = s.db.prepare('SELECT 1 FROM users WHERE username = ?').get(a.username);
  if (taken) throw new HttpError(409, 'that username is already taken');
  const id = randomUUID();
  s.db
    .prepare('INSERT INTO users (id, username, password_hash, role, name, team_id, skills, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, a.username, hashPassword(a.password), a.role, a.name, a.role === 'rescuer' ? a.teamId : null, JSON.stringify(a.skills), s.now().toISOString());
  s.audit(actor, 'user.created', id, { username: a.username, role: a.role, teamId: a.teamId });
  return { id };
}

export type { Site };
