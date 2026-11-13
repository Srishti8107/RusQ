/** Team assignments: the control room sends teams to locations by priority; teams report progress. */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Assignment } from '@rusq/shared';
import { buildApp } from '../src/app.ts';
import { DEMO_PASSWORD } from '../src/seed.ts';

type App = Awaited<ReturnType<typeof buildApp>>;
let ctx: App;
const tok: Record<string, string> = {};

async function login(u: string) {
  const r = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: DEMO_PASSWORD } });
  tok[u] = r.json().token;
}
const call = (u: string | null, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  ctx.app.inject({ method, url, payload: payload as object, headers: u ? { authorization: `Bearer ${tok[u]}` } : {} });

const base = { teamId: 'team-alpha', lat: 27.7, lng: 85.32, place: 'Thapathali bridge', priority: 'high', instructions: 'Evacuate the families on the east bank' };

beforeEach(async () => {
  ctx = await buildApp({ seed: true, testUsers: true, rateLimitMax: 100000, loginRateLimitMax: 1000 });
  for (const u of ['asha', 'ravi', 'meena', 'admin']) await login(u);
});

describe('team assignments', () => {
  it('admin assigns locations by priority; the team sees its own, highest priority first', async () => {
    const low = (await call('admin', 'POST', '/api/admin/assignments', { ...base, place: 'School', priority: 'low' })).json() as Assignment;
    const crit = (await call('admin', 'POST', '/api/admin/assignments', { ...base, place: 'Riverside houses', priority: 'critical' })).json() as Assignment;
    await call('admin', 'POST', '/api/admin/assignments', { ...base, teamId: 'team-bravo', place: 'Market' });
    expect(crit).toMatchObject({ status: 'assigned', serverId: expect.stringMatching(/^ASG-\d{6}$/), createdBy: 'District Control Room' });

    const tasks = (await call('ravi', 'GET', '/api/team/tasks')).json();
    expect(tasks.assignments.map((a: Assignment) => a.place)).toEqual(['Riverside houses', 'School']);
    const bravo = (await call('meena', 'GET', '/api/team/tasks')).json();
    expect(bravo.assignments.map((a: Assignment) => a.place)).toEqual(['Market']);

    // board: workload per team
    const board = (await call('admin', 'GET', '/api/admin/assignments')).json();
    const alpha = board.teams.find((t: { teamId: string }) => t.teamId === 'team-alpha');
    expect(alpha).toMatchObject({ active: 2, byPriority: { critical: 1, high: 0, medium: 0, low: 1 } });
    expect(board.assignments[0].place).toBe('Riverside houses');
    expect(board.areas.length).toBeGreaterThan(0); // seeded flood data gives priority areas
    expect(board.areas[0]).toMatchObject({ rank: 1, priority: expect.stringMatching(/critical|high|medium|low/) });
    void low;
  });

  it('the team moves its assignment forward only; other teams cannot touch it', async () => {
    const a = (await call('admin', 'POST', '/api/admin/assignments', base)).json() as Assignment;
    expect((await call('meena', 'POST', `/api/team/assignments/${a.id}/status`, { status: 'in_progress' })).statusCode).toBe(403);
    expect((await call('ravi', 'POST', `/api/team/assignments/${a.id}/status`, { status: 'in_progress' })).json().status).toBe('in_progress');
    expect((await call('ravi', 'POST', `/api/team/assignments/${a.id}/status`, { status: 'in_progress' })).statusCode).toBe(409);
    const done = (await call('ravi', 'POST', `/api/team/assignments/${a.id}/status`, { status: 'done', note: '12 people moved to the school' })).json();
    expect(done).toMatchObject({ status: 'done', teamNote: '12 people moved to the school', updatedBy: 'Ravi Shrestha (Team Alpha)' });
    expect((await call('ravi', 'GET', '/api/team/tasks')).json().assignments).toEqual([]); // done ones leave the list
    expect((await call('admin', 'GET', '/api/admin/assignments')).json().assignments[0].status).toBe('done');
  });

  it('admin changes priority, reassigns (progress resets) and cancels', async () => {
    const a = (await call('admin', 'POST', '/api/admin/assignments', base)).json() as Assignment;
    await call('ravi', 'POST', `/api/team/assignments/${a.id}/status`, { status: 'in_progress' });
    expect((await call('admin', 'POST', `/api/admin/assignments/${a.id}`, { priority: 'critical' })).json()).toMatchObject({ priority: 'critical', status: 'in_progress' });
    const moved = (await call('admin', 'POST', `/api/admin/assignments/${a.id}`, { teamId: 'team-bravo' })).json();
    expect(moved).toMatchObject({ teamId: 'team-bravo', status: 'assigned' });
    expect((await call('meena', 'GET', '/api/team/tasks')).json().assignments).toHaveLength(1);
    expect((await call('ravi', 'GET', '/api/team/tasks')).json().assignments).toHaveLength(0);
    expect((await call('admin', 'POST', `/api/admin/assignments/${a.id}`, { status: 'cancelled' })).json().status).toBe('cancelled');
    expect((await call('meena', 'GET', '/api/team/tasks')).json().assignments).toHaveLength(0);
  });

  it('checks input and roles', async () => {
    expect((await call('admin', 'POST', '/api/admin/assignments', { ...base, teamId: 'team-nobody' })).statusCode).toBe(400);
    expect((await call('admin', 'POST', '/api/admin/assignments', { ...base, priority: 'urgent' })).statusCode).toBe(400);
    expect((await call('admin', 'POST', '/api/admin/assignments', { ...base, place: '' })).statusCode).toBe(400);
    expect((await call('ravi', 'POST', '/api/admin/assignments', base)).statusCode).toBe(403);
    expect((await call('asha', 'GET', '/api/admin/assignments')).statusCode).toBe(403);
    const a = (await call('admin', 'POST', '/api/admin/assignments', base)).json() as Assignment;
    expect((await call('asha', 'POST', `/api/team/assignments/${a.id}/status`, { status: 'done' })).statusCode).toBe(403);
    expect((await call('admin', 'POST', `/api/admin/assignments/${a.id}`, {})).statusCode).toBe(400);
    expect((await call('admin', 'POST', '/api/admin/assignments/00000000-0000-4000-8000-000000000000', { priority: 'low' })).statusCode).toBe(404);
  });

  it('the control room gets a pop-up when a team reports progress (not for its own changes)', async () => {
    const since = (await call('admin', 'GET', '/api/admin/feed')).json().now;
    const a = (await call('admin', 'POST', '/api/admin/assignments', base)).json() as Assignment;
    await call('admin', 'POST', `/api/admin/assignments/${a.id}`, { priority: 'critical' });
    await new Promise((r) => setTimeout(r, 5));
    await call('ravi', 'POST', `/api/team/assignments/${a.id}/status`, { status: 'in_progress' });
    await new Promise((r) => setTimeout(r, 5));
    await call('ravi', 'POST', `/api/team/assignments/${a.id}/status`, { status: 'done', note: 'all safe' });
    const feed = (await call('admin', 'GET', `/api/admin/feed?since=${encodeURIComponent(since)}`)).json();
    const items = feed.items.filter((i: { kind: string }) => i.kind === 'assignment');
    expect(items.map((i: { title: string }) => i.title)).toEqual(['Team Alpha is on the way to Thapathali bridge', 'Team Alpha finished: Thapathali bridge']);
    expect(items[1]).toMatchObject({ serverId: a.serverId, detail: 'critical priority · “all safe”' });
  });
});
