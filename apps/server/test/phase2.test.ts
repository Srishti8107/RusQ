/** Phase 2 server integration: registration/profile, RBAC, SOS monitor, decision support, CCTV, missing persons, staff, migration. */
import { beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importServerPublicKey, importTeamKey, MeshNode, verifyAck, VERIFY_CHECKLIST, type Ack, type FieldReport, type MissingReport, type Sos } from '@rusq/shared';
import { buildApp } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { DEMO_PASSWORD } from '../src/seed.ts';

type App = Awaited<ReturnType<typeof buildApp>>;
let ctx: App;
const tok: Record<string, string> = {};
const ids: Record<string, string> = {};
let n = 0;
const uid = () => `01900000-0000-7000-8000-${(++n).toString(16).padStart(12, '0')}`;
const H = (u: string) => ({ authorization: `Bearer ${tok[u]}` });

async function login(u: string) {
  const r = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: DEMO_PASSWORD } });
  expect(r.statusCode).toBe(200);
  tok[u] = r.json().token;
  ids[u] = r.json().user.id;
}

async function call(u: string | null, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  return ctx.app.inject({ method, url, payload: payload as object, headers: u ? H(u) : {} });
}

function report(over: Partial<FieldReport> = {}): FieldReport {
  const base: FieldReport = {
    id: uid(),
    teamId: 'team-alpha',
    lat: 27.6941,
    lng: 85.3212,
    locationSource: 'live',
    victimCount: 25,
    urgency: 5,
    notes: '',
    photos: [],
    requested: { boats: 3, food_water: 100 },
    aiSuggestion: null,
    humanFinal: { hazards: ['flooded street'], victimCount: 25, urgency: 5, requested: { boats: 3, food_water: 100 } },
    createdAt: new Date().toISOString(),
  };
  return { ...base, ...over };
}

function missing(reporterId: string, over: Partial<MissingReport['person']> = {}): MissingReport {
  return {
    id: uid(),
    reporterId,
    person: { name: 'Rina Shrestha', age: 8, gender: 'female', description: 'red frock and a school bag', ...over },
    lastSeen: { place: 'Lainchaur market', lat: 27.714, lng: 85.309, at: new Date().toISOString() },
    contactPhone: '+91 00000 00999',
    relation: 'mother',
    photos: [],
    createdAt: new Date().toISOString(),
  };
}

beforeEach(async () => {
  ctx = await buildApp({ seed: true, testUsers: true, rateLimitMax: 100000, loginRateLimitMax: 1000, registerRateLimitMax: 1000 });
  for (const u of ['asha', 'ravi', 'meena', 'kiran', 'admin']) await login(u);
});

describe('registration and profile', () => {
  const reg = {
    userId: 'gita',
    profile: {
      name: 'Gita Rai',
      contacts: [{ name: 'Mohan', phone: '+977 00000 11111', relation: 'husband' }],
      details: { age: 72, householdSize: 3, needs: ['elderly'], occupation: 'Farmer', workplace: 'Sankhu fields' },
    },
  };

  it('a person can register, gets a victim token and a profile stored on the server', async () => {
    const r = await call(null, 'POST', '/api/auth/register', reg);
    expect(r.statusCode).toBe(200);
    expect(r.json().user.role).toBe('victim');
    const t = r.json().token;
    const me = await ctx.app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${t}` } });
    expect(me.json().profile.contacts[0].name).toBe('Mohan');
    expect(me.json().profile.details.needs).toEqual(['elderly']);
    expect(me.json().profile.details).toMatchObject({ occupation: 'Farmer', workplace: 'Sankhu fields' });
    // the new account signs in with its USER ID only – no password
    const l = await call(null, 'POST', '/api/auth/login', { username: 'gita' });
    expect(l.statusCode).toBe(200);
    expect(l.json().user).toMatchObject({ username: 'gita', role: 'victim' });
  });

  it('staff accounts still need their password; victims never do', async () => {
    expect((await call(null, 'POST', '/api/auth/login', { username: 'ravi' })).statusCode).toBe(401);
    expect((await call(null, 'POST', '/api/auth/login', { username: 'admin', password: 'wrong-password' })).statusCode).toBe(401);
    expect((await call(null, 'POST', '/api/auth/login', { username: 'admin' })).json().error).toMatch(/need their password/);
    expect((await call(null, 'POST', '/api/auth/login', { username: 'asha' })).statusCode).toBe(200);
    expect((await call(null, 'POST', '/api/auth/login', { username: 'nobody-here' })).statusCode).toBe(401);
  });

  it('rejects a taken user ID (409) and a bad user ID (400); registration cannot pick a role or set a password', async () => {
    expect((await call(null, 'POST', '/api/auth/register', { ...reg, userId: 'asha' })).statusCode).toBe(409);
    expect((await call(null, 'POST', '/api/auth/register', { ...reg, userId: 'x2' })).statusCode).toBe(400);
    expect((await call(null, 'POST', '/api/auth/register', { ...reg, userId: 'Bad Name!' })).statusCode).toBe(400);
    const r = await call(null, 'POST', '/api/auth/register', { ...reg, userId: 'sneaky', role: 'admin', password: 'x' });
    expect(r.json().user.role).toBe('victim');
  });

  it('profile update is last-write-wins by updatedAt (offline edits uploaded late do not clobber newer ones)', async () => {
    const p = { name: 'Asha Gurung', contacts: [], details: { needs: [] }, updatedAt: '2030-01-01T00:00:00.000Z' };
    expect((await call('asha', 'PUT', '/api/me/profile', p)).json().applied).toBe(true);
    const old = await call('asha', 'PUT', '/api/me/profile', { ...p, name: 'Old name', updatedAt: '2029-01-01T00:00:00.000Z' });
    expect(old.json().applied).toBe(false);
    expect((await call('asha', 'GET', '/api/me')).json().profile.name).toBe('Asha Gurung');
    expect((await call('asha', 'PUT', '/api/me/profile', { ...p, contacts: [{ name: 'x', phone: '1' }] })).statusCode).toBe(400);
  });

  it('seeded shelters come with details and free capacity', async () => {
    const r = await call('asha', 'GET', '/api/shelters');
    expect(r.json().shelters).toHaveLength(8); // Kathmandu district sample
    expect(r.json().shelters.every((x: { lat: number; lng: number }) => x.lat > 27.6 && x.lat < 27.8 && x.lng > 85.2 && x.lng < 85.4)).toBe(true);
    expect(r.json().shelters[0]).toMatchObject({ sample: true });
    expect(r.json().shelters.find((s: { id: string }) => s.id === 'shelter-03').facilities).toContain('medical camp');
  });
});

describe('role-based access (Gate 2)', () => {
  const adminGets = ['/api/admin/dashboard', '/api/admin/sos-monitor', '/api/admin/reports-view', '/api/admin/decisions', '/api/admin/cctv', '/api/admin/missing', '/api/admin/found-registry', '/api/admin/users', '/api/admin/sos', '/api/admin/reports', '/api/admin/reconciliation', '/api/admin/audit'];

  it('a victim cannot read any admin data; a rescuer cannot either', async () => {
    for (const u of ['asha', 'ravi']) for (const url of adminGets) expect((await call(u, 'GET', url)).statusCode, `${u} ${url}`).toBe(403);
    for (const url of adminGets) expect((await call(null, 'GET', url)).statusCode, url).toBe(401);
  });

  it('a rescuer cannot approve allotments, decide recommendations, change SOS status, act on missing persons or create users', async () => {
    const fake = uid();
    expect((await call('ravi', 'POST', `/api/admin/allotments/${fake}/decision`, { decision: 'approve' })).statusCode).toBe(403);
    expect((await call('ravi', 'POST', '/api/admin/decisions/priority_area:x:1', { decision: 'approve' })).statusCode).toBe(403);
    expect((await call('ravi', 'POST', `/api/admin/sos/${fake}/status`, { status: 'resolved' })).statusCode).toBe(403);
    expect((await call('ravi', 'POST', `/api/admin/missing/${fake}/action`, { action: 'verify' })).statusCode).toBe(403);
    expect((await call('ravi', 'POST', '/api/admin/users', {})).statusCode).toBe(403);
    expect((await call('ravi', 'PUT', '/api/admin/cctv', { enabled: false })).statusCode).toBe(403);
  });

  it('team tasks are for rescuers only', async () => {
    expect((await call('ravi', 'GET', '/api/team/tasks')).statusCode).toBe(200);
    expect((await call('asha', 'GET', '/api/team/tasks')).statusCode).toBe(403);
  });
});

describe('SOS monitor', () => {
  it('shows triage with reasons, contacts from the profile, and admin status changes reach the victim and the assigned team', async () => {
    const me = (await call('asha', 'GET', '/api/me')).json();
    const sos: Sos = {
      id: uid(),
      userId: ids.asha!,
      lat: 27.6945,
      lng: 85.3215,
      accuracy: 15,
      locationSource: 'live',
      createdAt: new Date().toISOString(),
      source: 'app',
      profile: { name: me.profile.name, contacts: me.profile.contacts, medicalNotes: me.profile.details.medicalNotes, age: 68, householdSize: 2, needs: ['elderly', 'medical'] },
    };
    expect((await call('asha', 'POST', '/api/sync', { items: [{ kind: 'sos', data: sos }] })).json().acks).toHaveLength(1);
    const mon = (await call('admin', 'GET', '/api/admin/sos-monitor')).json();
    const row = mon.sos.find((x: { id: string }) => x.id === sos.id);
    expect(row.triage.level).toBe(5);
    expect(row.triage.reasons.join(' ')).toMatch(/vulnerable/);
    expect(row.profile.contacts[0].phone).toBe('+977 00000 00201');

    expect((await call('admin', 'POST', `/api/admin/sos/${sos.id}/status`, { status: 'assigned' })).statusCode).toBe(400); // team required
    expect((await call('admin', 'POST', `/api/admin/sos/${sos.id}/status`, { status: 'assigned', teamId: 'team-nope' })).statusCode).toBe(400);
    expect((await call('admin', 'POST', `/api/admin/sos/${sos.id}/status`, { status: 'assigned', teamId: 'team-alpha', note: 'Boat 2 on the way' })).statusCode).toBe(200);
    const mine = (await call('asha', 'GET', '/api/me/sos')).json();
    expect(mine[0]).toMatchObject({ status: 'assigned', assignedTeam: 'Team Alpha' });
    const tasks = (await call('ravi', 'GET', '/api/team/tasks')).json();
    expect(tasks.sos[0]).toMatchObject({ name: 'Asha Gurung', note: 'Boat 2 on the way' });
    expect((await call('meena', 'GET', '/api/team/tasks')).json().sos).toHaveLength(0);
    const audit = (await call('admin', 'GET', '/api/admin/audit')).json();
    expect(audit.some((a: { action: string }) => a.action === 'sos.assigned')).toBe(true);
  });
});

describe('decision support', () => {
  it('produces recommendations with reasoning; approve is final, audit-logged, and an approved team assignment becomes that team’s task', async () => {
    await call('ravi', 'POST', '/api/sync', { items: [{ kind: 'report', data: report() }] });
    await call('meena', 'POST', '/api/sync', { items: [{ kind: 'report', data: report({ teamId: 'team-bravo', lat: 27.7040, lng: 85.3145, victimCount: 6, humanFinal: { hazards: ['collapsed building'], victimCount: 6, urgency: 4, requested: { medical_supplies: 5 } } }) }] });
    const d = (await call('admin', 'GET', '/api/admin/decisions')).json();
    const recs = d.output.recommendations as { id: string; kind: string; reasoning: string[]; proposal: { teamId?: string } }[];
    expect(recs.length).toBeGreaterThan(3);
    for (const r of recs) expect(r.reasoning.length).toBeGreaterThan(0);
    const team = recs.find((r) => r.kind === 'team_assignment')!;
    expect(team).toBeTruthy();

    expect((await call('admin', 'POST', `/api/admin/decisions/${encodeURIComponent(team.id)}`, { decision: 'approve', note: 'go' })).statusCode).toBe(200);
    expect((await call('admin', 'POST', `/api/admin/decisions/${encodeURIComponent(team.id)}`, { decision: 'reject' })).statusCode).toBe(409);
    expect((await call('admin', 'POST', '/api/admin/decisions/priority_area:nothing:00000000', { decision: 'approve' })).statusCode).toBe(409);

    const after = (await call('admin', 'GET', '/api/admin/decisions')).json();
    expect(after.decided[team.id].decision).toBe('approve');
    const who = team.proposal.teamId === 'team-alpha' ? 'ravi' : team.proposal.teamId === 'team-bravo' ? 'meena' : 'kiran';
    expect((await call(who, 'GET', '/api/team/tasks')).json().tasks[0].id).toBe(team.id);
    const audit = (await call('admin', 'GET', '/api/admin/audit')).json();
    expect(audit.some((a: { action: string; target: string }) => a.action === 'recommendation.approved' && a.target === team.id)).toBe(true);
  });

  it('CCTV sample data can be switched off and then no longer feeds the rules', async () => {
    const on = (await call('admin', 'GET', '/api/admin/decisions')).json();
    expect(on.output.cells.some((c: { evidence: { cctv: string[] } }) => c.evidence.cctv.length > 0)).toBe(true);
    await call('admin', 'PUT', '/api/admin/cctv', { enabled: false });
    const off = (await call('admin', 'GET', '/api/admin/decisions')).json();
    expect(off.output.cells.some((c: { evidence: { cctv: string[] } }) => c.evidence.cctv.length > 0)).toBe(false);
    const cams = (await call('admin', 'GET', '/api/admin/cctv')).json();
    expect(cams.sample).toBe(true);
    expect(cams.enabled).toBe(false);
  });

  it('dashboard aggregates counts, resources, timeline and map layers', async () => {
    await call('ravi', 'POST', '/api/sync', { items: [{ kind: 'report', data: report() }] });
    const d = (await call('admin', 'GET', '/api/admin/dashboard')).json();
    expect(d.counts.reports).toBe(1);
    expect(d.counts.peopleReported).toBe(25);
    expect(d.timeline).toHaveLength(24);
    expect(d.timeline.at(-1).reports).toBe(1);
    expect(d.resources.find((r: { resource: string }) => r.resource === 'boats')).toMatchObject({ stock: 4, requested: 3 });
    expect(d.map.reports).toHaveLength(1);
    expect(d.shelters).toHaveLength(8);
  });
});

describe('missing persons (sample data, manual verification)', () => {
  async function submit(u: string, m: MissingReport) {
    return (await call(u, 'POST', '/api/sync', { items: [{ kind: 'missing', data: m }] })).json() as { acks: Ack[]; rejected: { reason: string }[] };
  }
  const act = (id: string, body: object) => call('admin', 'POST', `/api/admin/missing/${id}/action`, body);
  const checks = Object.fromEntries(VERIFY_CHECKLIST.map((c) => [c.id, true]));

  it('full workflow: proposed → review → verified by named admin → announced; nothing skippable; family sees nothing before verified', async () => {
    const m = missing(ids.asha!);
    const res = await submit('asha', m);
    expect(res.acks).toHaveLength(1);
    const key = await importServerPublicKey(ctx.services.keys.ackPublicJwk);
    expect(await verifyAck(key, res.acks[0]!)).toBe(true);
    expect(res.acks[0]!.kind).toBe('missing');

    // idempotent: same id 5 times → one record
    for (let i = 0; i < 5; i++) expect((await submit('asha', m)).acks[0]!.duplicate).toBe(true);
    let admin = (await call('admin', 'GET', '/api/admin/missing')).json();
    expect(admin).toHaveLength(1);
    expect(admin[0].state).toBe('candidate_found');
    expect(admin[0].candidates[0]).toMatchObject({ foundPersonId: 'FP-001', sample: true });

    const familyBefore = JSON.stringify((await call('asha', 'GET', '/api/me/missing')).json());
    expect(familyBefore).toMatch(/"status":"reported"/);
    expect(familyBefore).not.toMatch(/FP-001|confidence|candidate|Lainchaur, main/i);
    expect((await call('asha', 'GET', '/api/announcements')).json()).toHaveLength(0);

    // skipping is impossible
    expect((await act(m.id, { action: 'verify', candidateId: 'FP-001', checks, note: 'Confirmed by phone.' })).statusCode).toBe(409);
    expect((await act(m.id, { action: 'announce' })).statusCode).toBe(409);

    expect((await act(m.id, { action: 'start_review' })).statusCode).toBe(200);
    expect(JSON.stringify((await call('asha', 'GET', '/api/me/missing')).json())).toMatch(/"status":"reported"/);
    expect((await act(m.id, { action: 'announce' })).statusCode).toBe(409);
    // incomplete checklist / no note → refused
    expect((await act(m.id, { action: 'verify', candidateId: 'FP-001', checks: { compared: true }, note: 'Confirmed by phone.' })).statusCode).toBe(409);
    expect((await act(m.id, { action: 'verify', candidateId: 'FP-001', checks, note: '' })).statusCode).toBe(409);

    expect((await act(m.id, { action: 'verify', candidateId: 'FP-001', checks, note: 'Warden confirmed by phone; mother described the bag.' })).statusCode).toBe(200);
    const fam = (await call('asha', 'GET', '/api/me/missing')).json()[0];
    expect(fam.status).toBe('verified');
    expect(fam.found).toMatchObject({ shelterName: 'Community School, Lainchaur', verifiedBy: 'District Control Room' });
    expect((await call('asha', 'GET', '/api/announcements')).json()).toHaveLength(0); // verified ≠ announced

    expect((await act(m.id, { action: 'announce' })).statusCode).toBe(200);
    const ann = (await call('ravi', 'GET', '/api/announcements')).json();
    expect(ann[0]).toMatchObject({ personName: 'Rina Shrestha', verifiedBy: 'District Control Room', sample: true });

    admin = (await call('admin', 'GET', '/api/admin/audit')).json();
    for (const a of ['missing.reported', 'missing.candidates_proposed', 'missing.start_review', 'missing.verify', 'missing.announce'])
      expect(admin.some((x: { action: string }) => x.action === a), a).toBe(true);
  });

  it('rejecting the candidates returns the case to "reported"; a report with no plausible match stays "reported"', async () => {
    const m = missing(ids.asha!);
    await submit('asha', m);
    await act(m.id, { action: 'start_review' });
    expect((await act(m.id, { action: 'reject_candidates', note: 'Different child' })).json().state).toBe('reported');
    const nomatch = missing(ids.asha!, { name: 'Zzyzx Qwerty', age: 40, gender: 'male', description: 'nothing alike' });
    await submit('asha', nomatch);
    const all = (await call('admin', 'GET', '/api/admin/missing')).json();
    expect(all.find((x: { id: string }) => x.id === nomatch.id).state).toBe('reported');
    expect(all.find((x: { id: string }) => x.id === nomatch.id).candidates).toHaveLength(0);
  });

  it('a person can only report as themselves; families only ever see their own reports', async () => {
    const res = await submit('ravi', missing(ids.asha!));
    expect(res.rejected[0]!.reason).toMatch(/reporterId/);
    await submit('asha', missing(ids.asha!));
    expect((await call('ravi', 'GET', '/api/me/missing')).json()).toHaveLength(0);
  });
});

describe('staff accounts', () => {
  it('an admin creates a rescuer who can then sign in; the new team appears in decision support', async () => {
    const r = await call('admin', 'POST', '/api/admin/users', { username: 'dipu', password: 'longpassword', name: 'Dipu (Team Delta)', role: 'rescuer', teamId: 'team-delta', skills: ['medical'] });
    expect(r.statusCode).toBe(200);
    expect((await call(null, 'POST', '/api/auth/login', { username: 'dipu', password: 'longpassword' })).json().user.teamId).toBe('team-delta');
    expect((await call('admin', 'POST', '/api/admin/users', { username: 'dipu', password: 'longpassword', name: 'x', role: 'rescuer', teamId: 'team-delta' })).statusCode).toBe(409);
    expect((await call('admin', 'POST', '/api/admin/users', { username: 'nobody', password: 'longpassword', name: 'x', role: 'rescuer' })).statusCode).toBe(400);
    const users = (await call('admin', 'GET', '/api/admin/users')).json();
    expect(users.some((u: { username: string }) => u.username === 'dipu')).toBe(true);
    expect(JSON.stringify(users)).not.toMatch(/password|scrypt/);
    const teams = (await call('admin', 'GET', '/api/admin/sos-monitor')).json().teams as { teamId: string; skills: string[] }[];
    expect(teams.find((t) => t.teamId === 'team-delta')?.skills).toEqual(['medical']);
  });
});

describe('accounts in a normal start (decisions.md 12.13)', () => {
  it('only the admin account exists without test fixtures; old demo profiles are removed once, later sign-ups are kept', async () => {
    const plain = await buildApp({ seed: true });
    const names = (plain.services.db.prepare('SELECT username FROM users').all() as { username: string }[]).map((u) => u.username);
    expect(names).toEqual(['admin']);
    await plain.app.close();

    // an older database that still holds the general demo profiles (and the Guwahati sample)
    const path = join(mkdtempSync(join(tmpdir(), 'rusq-old-')), 'old.db');
    const old = openDb(path);
    for (const u of ['asha', 'ravi', 'demo-joy', 'admin', 'real-person'])
      old.prepare("INSERT INTO users (id, username, password_hash, role, name, created_at) VALUES (?, ?, '', ?, ?, '2026-01-01')").run(u, u, u === 'admin' ? 'admin' : 'victim', u);
    old.close();
    const up = await buildApp({ dbPath: path, seed: true });
    const left = (up.services.db.prepare('SELECT username FROM users ORDER BY username').all() as { username: string }[]).map((u) => u.username);
    expect(left).toEqual(['admin', 'real-person']);
    // a person who registers as "asha" afterwards is NOT removed on the next start
    up.services.db.prepare("INSERT INTO users (id, username, password_hash, role, name, created_at) VALUES ('n', 'asha', '', 'victim', 'New Asha', '2026-01-02')").run();
    await up.app.close();
    const again = await buildApp({ dbPath: path, seed: true });
    expect(again.services.db.prepare("SELECT 1 FROM users WHERE username = 'asha'").get()).toBeTruthy();
    expect(again.services.sites().filter((x) => x.kind === 'shelter')).toHaveLength(8);
    await again.app.close();
  });
});

describe('automatic nearby-phone pairing (decisions.md 12.10)', () => {
  it('phones on the same network see each other and swap offers; phones elsewhere do not', async () => {
    const tok = async (u: string) => (await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: 'demo1234' } })).json().token as string;
    const t = { asha: await tok('asha'), ravi: await tok('ravi'), meena: await tok('meena') };
    const poll = (who: keyof typeof t, body: unknown, ip = '10.0.0.5') =>
      ctx.app.inject({ method: 'POST', url: '/api/peer/poll', headers: { authorization: 'Bearer ' + t[who] }, payload: body as object, remoteAddress: ip });
    expect((await ctx.app.inject({ method: 'POST', url: '/api/peer/poll', payload: { nodeId: 'x' } })).statusCode).toBe(401);
    expect((await poll('asha', { nodeId: 'node-a' })).json()).toEqual({ peers: [], inbox: [] });
    expect((await poll('ravi', { nodeId: 'node-b' })).json().peers).toEqual(['node-a']);
    expect((await poll('meena', { nodeId: 'node-far' }, '10.9.9.9')).json().peers).toEqual([]); // another network
    // A (smaller id) sends an offer to B; a message to the far phone is dropped
    await poll('asha', { nodeId: 'node-a', out: [{ to: 'node-b', type: 'offer', sdp: 'Zoffer', linkId: 'L1' }, { to: 'node-far', type: 'offer', sdp: 'Zx', linkId: 'L2' }] });
    expect((await poll('ravi', { nodeId: 'node-b' })).json().inbox).toEqual([{ from: 'node-a', type: 'offer', sdp: 'Zoffer', linkId: 'L1' }]);
    expect((await poll('ravi', { nodeId: 'node-b' })).json().inbox).toEqual([]); // delivered once
    expect((await poll('meena', { nodeId: 'node-far' }, '10.9.9.9')).json().inbox).toEqual([]);
    await poll('ravi', { nodeId: 'node-b', out: [{ to: 'node-a', type: 'answer', sdp: 'Zanswer', linkId: 'L1' }] });
    expect((await poll('asha', { nodeId: 'node-a' })).json().inbox[0]).toMatchObject({ from: 'node-b', type: 'answer', linkId: 'L1' });
  });
});

describe('change round 2 (decisions.md 13.x)', () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 9)]);
  const put = (u: string, photoId: string, reportId: string) =>
    ctx.app.inject({ method: 'PUT', url: `/api/photos/${photoId}`, headers: { ...H(u), 'content-type': 'image/jpeg', 'x-report-id': reportId }, payload: jpeg });

  it('13.1 missing-person photos: only after the own report arrived; visible to the control room and that family only', async () => {
    const pid = uid();
    const m = { ...missing(ids.asha!), photos: [pid] };
    expect((await put('asha', pid, m.id)).statusCode).toBe(409); // report not on the server yet
    expect((await call('asha', 'POST', '/api/sync', { items: [{ kind: 'missing', data: m }] })).json().acks).toHaveLength(1);
    let cases = (await call('admin', 'GET', '/api/admin/missing')).json();
    expect(cases.find((c: { id: string }) => c.id === m.id).photos).toEqual([{ id: pid, received: false }]); // announced, still travelling
    expect((await put('asha', pid, m.id)).statusCode).toBe(200);
    cases = (await call('admin', 'GET', '/api/admin/missing')).json();
    expect(cases.find((c: { id: string }) => c.id === m.id).photos).toEqual([{ id: pid, received: true }]);
    // another person cannot attach photos to it, nor look at them; rescuers cannot look either
    const other = (await call(null, 'POST', '/api/auth/register', { userId: 'other-family', profile: { name: 'Other', contacts: [], details: { needs: [] } } })).json();
    tok.other = other.token;
    expect((await put('other', uid(), m.id)).statusCode).toBe(403);
    expect((await call('admin', 'GET', `/api/photos/${pid}`)).statusCode).toBe(200);
    expect((await call('asha', 'GET', `/api/photos/${pid}`)).statusCode).toBe(200);
    expect((await call('other', 'GET', `/api/photos/${pid}`)).statusCode).toBe(403);
    expect((await call('ravi', 'GET', `/api/photos/${pid}`)).statusCode).toBe(403);
  });

  it('13.3 a report that hopped A → B → C → server is recorded with 2 hops and the uploading user', async () => {
    const k = (await call('ravi', 'GET', '/api/setup/keys')).json();
    const node = async (id: string) =>
      new MeshNode({ nodeId: id, teamKey: await importTeamKey(k.teamKey), serverPublicKey: await importServerPublicKey(k.ackPublicJwk), now: () => Date.now(), newId: uid });
    const [a, b, c] = [await node('phone-a'), await node('phone-b'), await node('phone-c')];
    const r = report();
    await a.originate('report', r);
    for (const m of a.messagesFor({ nodeId: 'phone-b', seen: [] }, 50)) expect((await b.receive(m)).status).toBe('accepted');
    for (const m of b.messagesFor({ nodeId: 'phone-c', seen: [] }, 50)) expect((await c.receive(m)).status).toBe('accepted');
    const envs = c.messagesFor({ nodeId: 'server', seen: [] }, 50);
    expect(envs[0]!.hops).toBe(2);
    expect((await call('meena', 'POST', '/api/mesh/upload', { envelopes: envs })).json().acks).toHaveLength(1);
    const got = (await call('admin', 'GET', '/api/admin/reports')).json().find((x: { id: string }) => x.id === r.id);
    expect(got).toMatchObject({ via: 'relay', relayHops: 2, relayGateway: 'meena' });
  });

  it('13.4 admin feed: new SOS, reports and missing reports since the last check, oldest first; admin only', async () => {
    const first = (await call('admin', 'GET', '/api/admin/feed')).json();
    expect(first.items).toEqual([]);
    await new Promise((res) => setTimeout(res, 5));
    const s: Sos = { id: uid(), userId: ids.asha!, lat: 27.6945, lng: 85.3215, accuracy: 20, locationSource: 'live', createdAt: new Date().toISOString(), source: 'app', profile: { name: 'Asha Gurung', contacts: [] } };
    await call('asha', 'POST', '/api/sync', { items: [{ kind: 'sos', data: s }] });
    await call('ravi', 'POST', '/api/sync', { items: [{ kind: 'report', data: report() }] });
    const next = (await call('admin', 'GET', `/api/admin/feed?since=${encodeURIComponent(first.now)}`)).json();
    expect(next.items.map((i: { kind: string }) => i.kind)).toEqual(['sos', 'report']);
    expect(next.items[0].title).toMatch(/^SOS from /);
    expect(next.items[1].title).toBe('Field report from team-alpha');
    const again = (await call('admin', 'GET', `/api/admin/feed?since=${encodeURIComponent(next.now)}`)).json();
    expect(again.items).toEqual([]); // each item is reported once
    expect((await call('asha', 'GET', '/api/admin/feed')).statusCode).toBe(403);
    expect((await call('ravi', 'GET', '/api/admin/feed')).statusCode).toBe(403);
  });
});

describe('database upgrade', () => {
  it('a Phase 1 database (without the Phase 2 columns/tables) is upgraded in place, keeping its rows', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rusq-mig-')), 'old.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE sos (id TEXT PRIMARY KEY, server_id TEXT UNIQUE NOT NULL, user_id TEXT NOT NULL, data TEXT NOT NULL, via TEXT NOT NULL, received_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open');
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL, name TEXT NOT NULL, team_id TEXT, skills TEXT NOT NULL DEFAULT '[]', profile TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
      INSERT INTO sos VALUES ('a','SOS-000001','u','{}','direct','2026-01-01T00:00:00Z','open');`);
    old.close();
    const db = openDb(path);
    const cols = (db.prepare('PRAGMA table_info(sos)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['assigned_team', 'ops_note', 'status_by', 'status_at']));
    expect((db.prepare('SELECT COUNT(*) AS n FROM sos').get() as { n: number }).n).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'missing_reports'").get()).toBeTruthy();
    db.close();
  });
});
