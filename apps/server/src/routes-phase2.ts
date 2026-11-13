/**
 * Phase 2 HTTP API. Every route declares its role(s); the server enforces
 * them (requireRole) – the web app's hidden/visible navigation is only a
 * convenience, never the protection.
 *
 *  public   POST /api/auth/register
 *  any      GET  /api/me · PUT /api/me/profile · GET /api/me/sos · GET /api/me/missing
 *           GET  /api/shelters · GET /api/announcements
 *  rescuer  GET  /api/team/tasks
 *  admin    GET  /api/admin/dashboard · /admin/sos-monitor · /admin/reports-view
 *           POST /api/admin/sos/:id/status
 *           GET  /api/admin/decisions · POST /api/admin/decisions/:id
 *           GET/PUT /api/admin/cctv
 *           GET  /api/admin/missing · POST /api/admin/missing/:id/action · POST /api/admin/missing/:id/match
 *           GET  /api/admin/found-registry
 *           GET/POST /api/admin/users · GET /api/admin/feed (new SOS/reports/missing since a time)
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { cctvSignals, Profile, Registration, SAMPLE_CCTV, StaffAccount, Uuid } from '@rusq/shared';
import { requireRole, signToken } from './auth.ts';
import type { ServerKeys } from './keys.ts';
import { adminAction, announcements, familyCases, foundRegistry, listCasesForAdmin, proposeCandidates } from './missing-service.ts';
import {
  cctvEnabled,
  createStaff,
  dashboard,
  decideRecommendation,
  decisions,
  getProfile,
  listUsers,
  mySos,
  reportsView,
  saveProfile,
  setCctvEnabled,
  setSosStatus,
  shelters,
  SOS_STATUSES,
  sosMonitor,
  teams,
  teamTasks,
} from './ops-service.ts';
import { HttpError, type Services } from './services.ts';

export async function registerPhase2Routes(app: FastifyInstance, services: Services, keys: ServerKeys, opts: { registerRateLimitMax?: number }) {
  const any = requireRole(keys.tokenSecret);
  const rescuer = requireRole(keys.tokenSecret, 'rescuer');
  const admin = requireRole(keys.tokenSecret, 'admin');
  const db = services.db;

  /* ------------------------------ registration ------------------------------ */

  // Victims register themselves (rescuer/admin accounts are created by an admin).
  app.post('/api/auth/register', { config: { rateLimit: { max: opts.registerRateLimitMax ?? 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    // A USER ID and the profile – no password (decisions.md 12.2). The user ID is the sign-in name.
    const body = Registration.parse(req.body);
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(body.userId)) return reply.code(409).send({ error: 'That user ID is already taken – choose another one.' });
    const id = randomUUID();
    const now = services.now().toISOString();
    const profile: Profile = { ...body.profile, updatedAt: now };
    db.prepare("INSERT INTO users (id, username, password_hash, role, name, team_id, skills, profile, created_at) VALUES (?, ?, '', 'victim', ?, NULL, '[]', ?, ?)").run(
      id,
      body.userId,
      profile.name,
      JSON.stringify(profile),
      now,
    );
    services.audit(id, 'auth.registered', id, { userId: body.userId });
    const token = signToken(keys.tokenSecret, { sub: id, role: 'victim', name: profile.name, teamId: null });
    return { token, user: { id, username: body.userId, role: 'victim', name: profile.name, teamId: null }, profile };
  });

  /* ------------------------------ me ------------------------------ */

  app.get('/api/me', { preHandler: any }, async (req) => {
    const u = db.prepare('SELECT id, username, role, name, team_id FROM users WHERE id = ?').get(req.user!.sub) as Record<string, string> | undefined;
    if (!u) throw new HttpError(404, 'user not found');
    return { user: { id: u.id, username: u.username, role: u.role, name: u.name, teamId: u.team_id }, profile: getProfile(services, u.id!) };
  });

  app.put('/api/me/profile', { preHandler: any }, async (req) => saveProfile(services, req.user!.sub, Profile.parse(req.body)));

  app.get('/api/me/sos', { preHandler: any }, async (req) => mySos(services, req.user!.sub));

  app.get('/api/me/missing', { preHandler: any }, async (req) => familyCases(services, req.user!.sub));

  app.get('/api/shelters', { preHandler: any }, async () => shelters(services));

  app.get('/api/announcements', { preHandler: any }, async () => announcements(services));

  /* ------------------------------ rescuer ------------------------------ */

  app.get('/api/team/tasks', { preHandler: rescuer }, async (req) => ({ teamId: req.user!.teamId, ...teamTasks(services, req.user!.teamId) }));

  /* ------------------------------ admin ------------------------------ */

  app.get('/api/admin/dashboard', { preHandler: admin }, async () => dashboard(services));

  app.get('/api/admin/sos-monitor', { preHandler: admin }, async () => ({ sos: sosMonitor(services), teams: teams(services) }));

  app.post('/api/admin/sos/:id/status', { preHandler: admin }, async (req) => {
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const body = z.object({ status: z.enum(SOS_STATUSES), teamId: z.string().max(64).nullable().optional(), note: z.string().max(500).optional() }).parse(req.body);
    setSosStatus(services, id, body.status, req.user!.sub, { teamId: body.teamId, note: body.note });
    return { ok: true };
  });

  app.get('/api/admin/reports-view', { preHandler: admin }, async () => reportsView(services));

  app.get('/api/admin/decisions', { preHandler: admin }, async () => ({ ...decisions(services), cctvEnabled: cctvEnabled(services) }));

  app.post('/api/admin/decisions/:id', { preHandler: admin }, async (req) => {
    const { id } = z.object({ id: z.string().min(3).max(200) }).parse(req.params);
    const body = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(500).optional() }).parse(req.body);
    const rec = decideRecommendation(services, id, body.decision, { id: req.user!.sub, name: req.user!.name }, body.note);
    return { ok: true, rec };
  });

  app.get('/api/admin/cctv', { preHandler: admin }, async () => ({ enabled: cctvEnabled(services), cameras: SAMPLE_CCTV, signals: cctvSignals(SAMPLE_CCTV), sample: true }));

  app.put('/api/admin/cctv', { preHandler: admin }, async (req) => {
    const body = z.object({ enabled: z.boolean() }).parse(req.body);
    setCctvEnabled(services, body.enabled, req.user!.sub);
    return { enabled: body.enabled };
  });

  app.get('/api/admin/missing', { preHandler: admin }, async () => listCasesForAdmin(services));

  app.get('/api/admin/found-registry', { preHandler: admin }, async () => ({ sample: true, people: foundRegistry(services) }));

  app.post('/api/admin/missing/:id/match', { preHandler: admin }, async (req) => {
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return { proposed: proposeCandidates(services, id) };
  });

  app.post('/api/admin/missing/:id/action', { preHandler: admin }, async (req) => {
    const { id } = z.object({ id: Uuid }).parse(req.params);
    const body = z
      .object({
        action: z.enum(['start_review', 'reject_candidates', 'verify', 'announce']),
        candidateId: z.string().max(64).optional(),
        checks: z.record(z.string(), z.boolean()).optional(),
        note: z.string().max(1000).optional(),
      })
      .parse(req.body);
    const name = (db.prepare('SELECT name FROM users WHERE id = ?').get(req.user!.sub) as { name: string } | undefined)?.name ?? req.user!.name;
    const next = adminAction(services, id, body.action, { id: req.user!.sub, name, role: req.user!.role }, body);
    return { ok: true, state: next.state };
  });

  /**
   * Control-room alerts (decisions.md 13.4): everything that ARRIVED after `since`
   * (new SOS, field reports, missing-person reports), oldest first. The admin screens poll
   * it every few seconds and pop up a message for each item. `now` is the next `since`.
   */
  app.get('/api/admin/feed', { preHandler: admin }, async (req) => {
    const { since } = z.object({ since: z.string().max(40).optional() }).parse(req.query);
    const now = services.now().toISOString();
    if (!since) return { now, items: [] }; // first call: only start the clock
    type Row = { id: string; server_id: string; data: string; via: string; received_at: string; relay_hops: number | null; relay_gateway: string | null };
    const q = (table: string) =>
      db.prepare(`SELECT id, server_id, data, via, received_at, relay_hops, relay_gateway FROM ${table} WHERE received_at > ? ORDER BY received_at LIMIT 50`).all(since) as unknown as Row[];
    const relay = (r: Row) => (r.via === 'relay' ? { hops: r.relay_hops, gateway: r.relay_gateway } : null);
    const items = [
      ...q('sos').map((r) => {
        const s = JSON.parse(r.data) as { profile?: { name?: string; householdSize?: number }; lat: number | null; lng: number | null };
        return {
          kind: 'sos' as const,
          id: r.id,
          serverId: r.server_id,
          receivedAt: r.received_at,
          title: `SOS from ${s.profile?.name ?? 'a registered person'}`,
          detail: `${s.lat !== null ? `Location ${s.lat.toFixed(4)}, ${s.lng!.toFixed(4)}` : 'No location'}${s.profile?.householdSize ? ` · ${s.profile.householdSize} people in the house` : ''}`,
          relay: relay(r),
        };
      }),
      ...q('reports').map((r) => {
        const x = JSON.parse(r.data) as { teamId: string; humanFinal: { victimCount: number; urgency: number; hazards: string[] } };
        return {
          kind: 'report' as const,
          id: r.id,
          serverId: r.server_id,
          receivedAt: r.received_at,
          title: `Field report from ${x.teamId}`,
          detail: `${x.humanFinal.victimCount} people · urgency ${x.humanFinal.urgency}/5${x.humanFinal.hazards.length ? ` · ${x.humanFinal.hazards.join(', ')}` : ''}`,
          relay: relay(r),
        };
      }),
      ...q('missing_reports').map((r) => {
        const x = JSON.parse(r.data) as { person: { name: string }; lastSeen: { place: string } };
        return { kind: 'missing' as const, id: r.id, serverId: r.server_id, receivedAt: r.received_at, title: `Missing person: ${x.person.name}`, detail: `Last seen: ${x.lastSeen.place}`, relay: relay(r) };
      }),
    ].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    return { now: items.length ? items.at(-1)!.receivedAt : now, items };
  });

  app.get('/api/admin/users', { preHandler: admin }, async () => listUsers(services));

  app.post('/api/admin/users', { preHandler: admin }, async (req) => createStaff(services, StaffAccount.parse(req.body), req.user!.sub));
}
