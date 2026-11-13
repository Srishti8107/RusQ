/**
 * Team assignments (shared/assignment.ts): the control room sends a team to a location with a
 * priority; the team sees them on Home (highest priority first) and reports on the way / done.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AssignmentInput,
  AssignmentUpdate,
  isActive,
  sortAssignments,
  STATUS_LABEL,
  TeamAssignmentUpdate,
  teamMayMove,
  type Assignment,
  type AssignmentPriority,
  type Severity,
} from '@rusq/shared';
import { requireRole } from './auth.ts';
import { nextServerId } from './db.ts';
import type { ServerKeys } from './keys.ts';
import { decisions, teamName, teams } from './ops-service.ts';
import { HttpError, type Services } from './services.ts';

function userName(s: Services, id: string): string {
  return (s.db.prepare('SELECT name FROM users WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? id;
}

function load(s: Services, id: string): Assignment {
  const row = s.db.prepare('SELECT data FROM assignments WHERE id = ?').get(id) as { data: string } | undefined;
  if (!row) throw new HttpError(404, 'assignment not found');
  return JSON.parse(row.data) as Assignment;
}

function store(s: Services, a: Assignment) {
  s.db
    .prepare('UPDATE assignments SET team_id = ?, data = ?, status = ?, priority = ?, updated_at = ? WHERE id = ?')
    .run(a.teamId, JSON.stringify(a), a.status, a.priority, a.updatedAt, a.id);
}

export function listAssignments(s: Services, teamId?: string): Assignment[] {
  const rows = (teamId ? s.db.prepare('SELECT data FROM assignments WHERE team_id = ?').all(teamId) : s.db.prepare('SELECT data FROM assignments').all()) as { data: string }[];
  return sortAssignments(rows.map((r) => JSON.parse(r.data) as Assignment));
}

export function createAssignment(s: Services, input: AssignmentInput, actorId: string): Assignment {
  if (!teams(s).some((t) => t.teamId === input.teamId)) throw new HttpError(400, `unknown team ${input.teamId}`);
  const now = s.now().toISOString();
  const by = userName(s, actorId);
  const id = randomUUID();
  const serverId = nextServerId(s.db, 'ASG');
  const a: Assignment = { ...input, id, serverId, status: 'assigned', createdBy: by, createdAt: now, updatedAt: now, updatedBy: by, teamNote: null };
  s.db
    .prepare('INSERT INTO assignments (id, server_id, team_id, data, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, serverId, a.teamId, JSON.stringify(a), a.status, a.priority, now, now);
  s.audit(actorId, 'assignment.created', id, { serverId, teamId: a.teamId, priority: a.priority, place: a.place });
  return a;
}

/** Control room: change team, priority, instructions or status (incl. cancel / reopen). */
export function updateAssignment(s: Services, id: string, u: AssignmentUpdate, actorId: string): Assignment {
  const a = load(s, id);
  if (u.teamId !== undefined && !teams(s).some((t) => t.teamId === u.teamId)) throw new HttpError(400, `unknown team ${u.teamId}`);
  const before = { teamId: a.teamId, priority: a.priority, status: a.status };
  const next: Assignment = { ...a, ...Object.fromEntries(Object.entries(u).filter(([, v]) => v !== undefined)), updatedAt: s.now().toISOString(), updatedBy: userName(s, actorId) };
  // A new team starts from "assigned" (the old team's progress does not carry over).
  if (u.teamId !== undefined && u.teamId !== a.teamId && u.status === undefined && isActive(a)) {
    next.status = 'assigned';
    next.teamNote = null;
  }
  store(s, next);
  s.audit(actorId, 'assignment.updated', id, { serverId: a.serverId, before, after: { teamId: next.teamId, priority: next.priority, status: next.status } });
  return next;
}

/** The team itself: on the way → done. Only its own assignments, only forward. */
export function teamUpdateAssignment(s: Services, id: string, teamId: string | null, status: 'in_progress' | 'done', note: string | undefined, actorId: string): Assignment {
  const a = load(s, id);
  if (!teamId || a.teamId !== teamId) throw new HttpError(403, 'this assignment belongs to another team');
  if (!teamMayMove(a.status, status)) throw new HttpError(409, `it is already "${STATUS_LABEL[a.status]}"`);
  const next: Assignment = { ...a, status, teamNote: note ?? a.teamNote, updatedAt: s.now().toISOString(), updatedBy: userName(s, actorId) };
  store(s, next);
  s.audit(actorId, `assignment.${status}`, id, { serverId: a.serverId, note });
  return next;
}

const SEV_TO_PRIORITY: Record<Severity, AssignmentPriority> = { critical: 'critical', high: 'high', medium: 'medium', low: 'low' };

/** Everything the control-room screen needs: assignments, teams with their workload, priority areas. */
export function assignmentBoard(s: Services) {
  const list = listAssignments(s);
  const d = decisions(s).output;
  const suggested = new Map<string, string>();
  for (const r of d.recommendations) {
    if (r.kind === 'team_assignment') {
      const p = r.proposal as { cellId: string; teamId: string };
      suggested.set(p.cellId, p.teamId);
    }
  }
  const teamRows = teams(s).map((t) => {
    const active = list.filter((a) => a.teamId === t.teamId && isActive(a));
    return {
      ...t,
      active: active.length,
      byPriority: Object.fromEntries((['critical', 'high', 'medium', 'low'] as const).map((p) => [p, active.filter((a) => a.priority === p).length])),
      doneToday: list.filter((a) => a.teamId === t.teamId && a.status === 'done' && a.updatedAt.slice(0, 10) === s.now().toISOString().slice(0, 10)).length,
    };
  });
  const areas = d.cells
    .filter((c) => c.score > 0)
    .slice(0, 30)
    .map((c, i) => ({
      cellId: c.cellId,
      rank: i + 1,
      lat: c.lat,
      lng: c.lng,
      severity: c.severity,
      priority: SEV_TO_PRIORITY[c.severity],
      score: c.score,
      people: c.people,
      openSos: c.openSos,
      hazards: c.hazards,
      reasons: c.reasons,
      place: c.nearestShelter ? `Area near ${c.nearestShelter.name}` : `Area at ${c.lat.toFixed(3)}, ${c.lng.toFixed(3)}`,
      suggestedTeam: suggested.get(c.cellId) ?? null,
      assigned: list.filter((a) => a.cellId === c.cellId && isActive(a)).map((a) => ({ serverId: a.serverId, teamId: a.teamId, priority: a.priority })),
    }));
  return { assignments: list.map((a) => ({ ...a, teamName: teamName(a.teamId) })), teams: teamRows, areas };
}

export async function registerAssignmentRoutes(app: FastifyInstance, s: Services, keys: ServerKeys) {
  const admin = requireRole(keys.tokenSecret, 'admin');
  const rescuer = requireRole(keys.tokenSecret, 'rescuer');
  const Id = z.object({ id: z.string().uuid() });

  app.get('/api/admin/assignments', { preHandler: admin }, async () => assignmentBoard(s));

  app.post('/api/admin/assignments', { preHandler: admin }, async (req) => createAssignment(s, AssignmentInput.parse(req.body), req.user!.sub));

  app.post('/api/admin/assignments/:id', { preHandler: admin }, async (req) => {
    const { id } = Id.parse(req.params);
    return updateAssignment(s, id, AssignmentUpdate.parse(req.body), req.user!.sub);
  });

  app.post('/api/team/assignments/:id/status', { preHandler: rescuer }, async (req) => {
    const { id } = Id.parse(req.params);
    const b = TeamAssignmentUpdate.parse(req.body);
    return teamUpdateAssignment(s, id, req.user!.teamId, b.status, b.note, req.user!.sub);
  });
}

