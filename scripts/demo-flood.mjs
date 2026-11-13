/**
 * DEMO SCRIPT – fills a running RusQ server with a SAMPLE flood scenario (Bagmati flood,
 * Kathmandu district, Nepal – fictional people) through the REAL API, so the control-room
 * screens have something to show. Safe to run twice: every record has a fixed id, and the
 * server's idempotent upload ignores repeats.
 *
 *   npm run demo                                       # http://localhost:8787
 *   npm run demo -- https://xyz.trycloudflare.com
 *
 * A normal start has ONLY the admin account (decisions.md 12.12). Running this script is the
 * explicit choice to add SAMPLE accounts: three rescue teams (created by the admin through
 * People & teams, password demo1234) and four sample people needing help (registered with a
 * user ID only, like real people do).
 *
 * What it creates: 4 SOS (one waiting 45 min with nobody near → "unattended"), 3 field reports
 * from three teams, their PROVISIONAL allotments computed with the shared engine (together they
 * over-claim boats → a reconciliation conflict), and 2 missing-person reports (one matches the
 * sample registry). Runs through tsx (it imports the shared TypeScript engine directly).
 */
import { computeProvisionalAllotment, mulberry32, seededUuid } from '../packages/shared/src/index.ts';

const BASE = (process.argv[2] ?? 'http://localhost:8787').replace(/\/$/, '');
const id = seededUuid(mulberry32(20260720)); // fixed sequence → same ids every run
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

async function call(path, { token, body, method = body ? 'POST' : 'GET' } = {}) {
  const r = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}

async function login(username, password) {
  const r = await call('/auth/login', { body: password ? { username, password } : { username } });
  if (r.status !== 200) throw new Error(`login ${username}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

/** A sample person registers with a user ID only (no password). */
async function victim(userId, profile) {
  const r = await call('/auth/register', { body: { userId, profile } });
  if (r.status === 200) return r.body;
  if (r.status === 409) return login(userId);
  throw new Error(`register ${userId}: ${r.status} ${JSON.stringify(r.body)}`);
}

async function sync(token, items) {
  const r = await call('/sync', { token, body: { items } });
  if (r.status !== 200) throw new Error(`sync: ${r.status} ${JSON.stringify(r.body)}`);
  if (r.body.rejected.length) console.warn('  rejected:', r.body.rejected);
  return r.body.acks.map((a) => `${a.serverId}${a.duplicate ? ' (already there)' : ''}`);
}

console.log(`RusQ demo – SAMPLE flood scenario (Kathmandu) → ${BASE}`);
if ((await call('/health')).status !== 200) throw new Error('server not reachable – start it with "npm start"');

const admin = await login('admin', 'demo1234');

// --- sample rescue teams, created by the admin exactly like real staff accounts
const TEAMS = [
  { username: 'demo-ravi', name: 'Ravi Shrestha (Team Alpha, sample)', teamId: 'team-alpha', skills: ['boat', 'first_aid'] },
  { username: 'demo-meena', name: 'Meena Tamang (Team Bravo, sample)', teamId: 'team-bravo', skills: ['medical', 'search'] },
  { username: 'demo-kiran', name: 'Kiran Rai (Team Charlie, sample)', teamId: 'team-charlie', skills: ['boat', 'swimming', 'driving'] },
];
for (const t of TEAMS) {
  const r = await call('/admin/users', { token: admin.token, body: { ...t, password: 'demo1234', role: 'rescuer' } });
  if (r.status !== 200 && r.status !== 409) throw new Error(`create ${t.username}: ${r.status} ${JSON.stringify(r.body)}`);
}

// --- sample people needing help
const sita = await victim('demo-sita', {
  name: 'Sita Gurung (sample)',
  contacts: [{ name: 'Raju Gurung', phone: '+977 00000 00201', relation: 'son' }],
  details: { age: 68, householdSize: 2, needs: ['elderly', 'medical'], medicalNotes: 'Type 2 diabetes – needs insulin', occupation: 'Retired teacher' },
});
const laxmi = await victim('demo-laxmi', {
  name: 'Laxmi Maharjan (sample)',
  contacts: [{ name: 'Prem Maharjan', phone: '+977 00000 00301', relation: 'son' }],
  details: { age: 74, householdSize: 2, needs: ['elderly', 'disability'] },
});
const rahim = await victim('demo-rahim', {
  name: 'Rahim Ansari (sample)',
  contacts: [{ name: 'Salma Ansari', phone: '+977 00000 00302', relation: 'wife' }],
  details: { age: 38, householdSize: 5, needs: ['child'], medicalNotes: 'Daughter has asthma', occupation: 'Tailor', workplace: 'Ason bazaar' },
});
const bijay = await victim('demo-bijay', {
  name: 'Bijay Thapa (sample)',
  contacts: [{ name: 'Mina Thapa', phone: '+977 00000 00303', relation: 'sister' }],
  details: { age: 22, needs: [], occupation: 'Student' },
});

const prof = (u, extra = {}) => ({ name: u.user.name, contacts: [], ...extra });
const sos = (u, lat, lng, minAgo, profile, src = 'live') => ({
  kind: 'sos',
  data: { id: id(), userId: u.user.id, lat, lng, accuracy: lat === null ? null : 25, locationSource: lat === null ? 'none' : src, locationAt: lat === null ? null : ago(minAgo + 2), createdAt: ago(minAgo), source: 'app', profile },
});

console.log('SOS:');
console.log('  sita  ', await sync(sita.token, [sos(sita, 27.6945, 85.3215, 20, { ...prof(sita), contacts: [{ name: 'Raju Gurung', phone: '+977 00000 00201', relation: 'son' }], age: 68, householdSize: 2, needs: ['elderly', 'medical'], medicalNotes: 'Type 2 diabetes – needs insulin' })]));
console.log('  laxmi ', await sync(laxmi.token, [sos(laxmi, 27.7022, 85.3261, 45, { ...prof(laxmi), contacts: [{ name: 'Prem Maharjan', phone: '+977 00000 00301' }], age: 74, householdSize: 2, needs: ['elderly', 'disability'] }, 'last_known')]));
console.log('  rahim ', await sync(rahim.token, [sos(rahim, 27.7044, 85.3149, 15, { ...prof(rahim), contacts: [{ name: 'Salma Ansari', phone: '+977 00000 00302' }], age: 38, householdSize: 5, needs: ['child'], medicalNotes: 'Daughter has asthma' })]));
console.log('  bijay ', await sync(bijay.token, [sos(bijay, null, null, 10, { ...prof(bijay), contacts: [{ name: 'Mina Thapa', phone: '+977 00000 00303' }], age: 22 })]));

const snapshot = (await call('/snapshot', { token: sita.token })).body;
const teams = [
  { user: 'demo-ravi', lat: 27.6941, lng: 85.3212, victims: 30, urgency: 5, hazards: ['flooded street', 'people waiting for rescue'], req: { boats: 3, food_water: 150, rescue_equipment: 4 }, notes: 'Bagmati over the bank at Thapathali. Water at chest level, about 30 people on rooftops, 4 children. Fallen tree blocks the lane.', min: 25 },
  { user: 'demo-meena', lat: 27.704, lng: 85.3145, victims: 6, urgency: 4, hazards: ['collapsed building'], req: { medical_supplies: 10, first_aid_kits: 4, rescue_equipment: 2 }, notes: 'Part of a wall collapsed at the Tundikhel south gate. 2 injured, 1 trapped under debris.', min: 18 },
  { user: 'demo-kiran', lat: 27.7018, lng: 85.3251, victims: 18, urgency: 4, hazards: ['flooded street'], req: { boats: 2, food_water: 80, clothing_blankets: 30 }, notes: 'Babarmahal lane flooded, 18 people waiting on the community hall roof.', min: 12 },
];
console.log('Field reports + provisional allotments (computed offline-style with the shared engine):');
for (const t of teams) {
  const u = await login(t.user, 'demo1234');
  const reportId = id();
  const report = {
    id: reportId,
    teamId: u.user.teamId,
    lat: t.lat,
    lng: t.lng,
    locationSource: 'live',
    victimCount: t.victims,
    urgency: t.urgency,
    notes: t.notes,
    photos: [],
    requested: t.req,
    aiSuggestion: null,
    humanFinal: { hazards: t.hazards, victimCount: t.victims, urgency: t.urgency, requested: t.req },
    createdAt: ago(t.min),
  };
  const { allotment } = computeProvisionalAllotment({ snapshot, report, deviceId: t.user, id: id(), createdAt: ago(t.min) });
  console.log(`  ${t.user.padEnd(10)}`, await sync(u.token, [{ kind: 'report', data: report }, { kind: 'allotment', data: allotment }]), 'claim', JSON.stringify(allotment.claim));
}

console.log('Missing-person reports (SAMPLE):');
const missing = (u, person, place, lat, lng) => ({ kind: 'missing', data: { id: id(), reporterId: u.user.id, person, lastSeen: { place, ...(lat ? { lat, lng } : {}) }, contactPhone: '+977 00000 00999', relation: 'family', createdAt: ago(30) } });
console.log('  sita  ', await sync(sita.token, [missing(sita, { name: 'Rina Shrestha', age: 8, gender: 'female', description: 'red frock, school bag' }, 'Lainchaur market', 27.714, 85.309)]));
console.log('  rahim ', await sync(rahim.token, [missing(rahim, { name: 'Bikas Tamang', age: 70, gender: 'male', description: 'old man with walking stick' }, 'Tundikhel')]));

const d = (await call('/admin/dashboard', { token: admin.token })).body;
console.log(`\nDone. Dashboard now: ${d.counts.sosOpen} open SOS, ${d.counts.reports} reports, ${d.counts.criticalAreas} critical areas, ${d.counts.openConflicts} stock conflict(s), ${d.counts.missingOpen} missing-person case(s).`);
console.log('Sign in as admin / demo1234 and follow docs/DEMO.md. Sample people sign in with their user ID only (e.g. demo-sita).');
