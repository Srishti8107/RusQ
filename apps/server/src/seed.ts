/**
 * Seed for the SAMPLE flood scenario: Bagmati river flood in Kathmandu district, Nepal.
 * Shelter names, people and phone numbers are fictional; coordinates are real places in
 * Kathmandu so the offline map and distances make sense.
 *
 * Accounts: ONLY the control-room admin is created (owner's decision, decisions.md 12.13).
 * Victims register themselves; rescuer accounts are created by the admin (People & teams).
 * Automated tests may ask for fixture accounts with RUSQ_TEST_USERS=1 – never on by default.
 *
 * Idempotent: only fills what is missing; never overwrites real edits.
 */
import { randomUUID } from 'node:crypto';
import type { FoundPerson, Site } from '@rusq/shared';
import { kvGet, kvSet } from './db.ts';
import { hashPassword } from './auth.ts';
import type { Services } from './services.ts';

/** Password of the seeded admin (and of the test-only rescuer fixtures). Change it for any real use. */
export const DEMO_PASSWORD = 'demo1234';

export const ADMIN_USER = { username: 'admin', role: 'admin', name: 'District Control Room', teamId: null, skills: [] } as const;

/** Kathmandu district – sample shelters at real open spaces / localities (names and numbers are fictional). */
export const DEMO_SITES: Site[] = [
  { id: 'shelter-01', kind: 'shelter', name: 'Community School, Lainchaur', lat: 27.7156, lng: 85.3081, density: 320, urgency: 1, needs: { food_water: 400, medical_supplies: 20, clothing_blankets: 150, first_aid_kits: 10 }, capacity: 500 },
  { id: 'shelter-02', kind: 'shelter', name: 'Community Hall, Babarmahal', lat: 27.7012, lng: 85.3234, density: 210, urgency: 2, needs: { food_water: 300, clothing_blankets: 120, medical_supplies: 10 }, capacity: 260 },
  { id: 'shelter-03', kind: 'shelter', name: 'Open-Space Relief Camp, Tundikhel', lat: 27.704, lng: 85.3145, density: 640, urgency: 1, needs: { food_water: 800, medical_supplies: 40, clothing_blankets: 300, first_aid_kits: 25, transportation: 2 }, capacity: 1200 },
  { id: 'shelter-04', kind: 'shelter', name: 'Monastery Guest House, Swayambhu', lat: 27.7149, lng: 85.2904, density: 90, urgency: 1, needs: { food_water: 120, clothing_blankets: 40 }, capacity: 150 },
  { id: 'shelter-05', kind: 'shelter', name: 'Primary School, Thapathali', lat: 27.6926, lng: 85.3199, density: 150, urgency: 3, needs: { food_water: 200, medical_supplies: 15, boats: 1, rescue_equipment: 4 }, capacity: 200 },
  // More shelters in the district (no open requests yet → they don't change the allocation).
  { id: 'shelter-06', kind: 'shelter', name: 'Secondary School, Balaju', lat: 27.7275, lng: 85.3045, density: 120, urgency: 1, needs: {}, capacity: 400 },
  { id: 'shelter-07', kind: 'shelter', name: 'Ward Office Hall, Koteshwor', lat: 27.6785, lng: 85.3495, density: 60, urgency: 1, needs: {}, capacity: 300 },
  { id: 'shelter-08', kind: 'shelter', name: 'Monastery Courtyard, Boudha', lat: 27.7205, lng: 85.3615, density: 40, urgency: 1, needs: {}, capacity: 250 },
];

export const DEMO_STOCK = {
  food_water: 1500,
  medical_supplies: 70,
  first_aid_kits: 30,
  boats: 4,
  rescue_equipment: 10,
  clothing_blankets: 500,
  transportation: 3,
  other: 0,
};

export const DEMO_SHELTER_DETAILS: Record<string, { address: string; phone: string; facilities: string[] }> = {
  'shelter-01': { address: 'Lainchaur, main road', phone: '+977 00000 00101', facilities: ['drinking water', 'toilets', 'medical desk', 'women & children room'] },
  'shelter-02': { address: 'Babarmahal, inner lane', phone: '+977 00000 00102', facilities: ['drinking water', 'toilets', 'kitchen'] },
  'shelter-03': { address: 'Tundikhel open space, south gate', phone: '+977 00000 00103', facilities: ['drinking water', 'toilets', 'medical camp', 'kitchen', 'animal shelter', 'charging point'] },
  'shelter-04': { address: 'Swayambhu, ring-road side', phone: '+977 00000 00104', facilities: ['drinking water', 'toilets'] },
  'shelter-05': { address: 'Thapathali, near the Bagmati bridge', phone: '+977 00000 00105', facilities: ['drinking water', 'first aid', 'boat point'] },
  'shelter-06': { address: 'Balaju, near the bus park', phone: '+977 00000 00106', facilities: ['drinking water', 'toilets', 'kitchen'] },
  'shelter-07': { address: 'Koteshwor, ward office', phone: '+977 00000 00107', facilities: ['drinking water', 'toilets', 'charging point'] },
  'shelter-08': { address: 'Boudha, north courtyard', phone: '+977 00000 00108', facilities: ['drinking water', 'toilets', 'kitchen', 'women & children room'] },
};

/** SAMPLE registry of people registered at shelters – fictional names, no photos, no faces. */
export const DEMO_FOUND_PERSONS: FoundPerson[] = [
  ['FP-001', 'Rina Shrestha', 9, 'female', 'girl, red frock, school bag with a cartoon print', 'shelter-01'],
  ['FP-002', 'Bikash Tamang', 71, 'male', 'elderly man, walking stick, white daura suruwal, hard of hearing', 'shelter-03'],
  ['FP-003', 'Prakash Maharjan', 34, 'male', 'tall, beard, blue raincoat, injured left hand', 'shelter-02'],
  ['FP-004', 'Sushila Gurung', 27, 'female', 'green kurta, carrying a baby', 'shelter-03'],
  ['FP-005', 'Unknown boy (about 6)', 6, 'male', 'small boy, yellow t-shirt, says his father is Dipak', 'shelter-05'],
  ['FP-006', 'Hari Adhikari', 52, 'male', 'grey hair, spectacles, diabetic', 'shelter-01'],
  ['FP-007', 'Anjali Thapa', 15, 'female', 'school uniform, long plait, silver earrings', 'shelter-04'],
  ['FP-008', 'Junu Rai', 63, 'female', 'elderly woman, red sari and shawl, cannot walk far', 'shelter-03'],
  ['FP-009', 'Rakesh Karki', 41, 'male', 'taxi driver, khaki shirt, tattoo on right arm', 'shelter-02'],
  ['FP-010', 'Puja Shrestha', 12, 'female', 'pink frock, glasses', 'shelter-05'],
].map(([id, name, age, gender, description, shelterId]) => {
  const site = DEMO_SITES.find((x) => x.id === shelterId)!;
  return {
    id: id as string,
    name: name as string,
    approxAge: age as number,
    gender: gender as FoundPerson['gender'],
    description: description as string,
    shelterId: site.id,
    shelterName: site.name!,
    lat: site.lat,
    lng: site.lng,
    registeredAt: '2026-07-20T06:00:00.000Z',
    sample: true as const,
  };
});

/**
 * TEST FIXTURES ONLY (RUSQ_TEST_USERS=1 / buildApp({ testUsers: true })). Not created in a normal start.
 * Victims have no password (they sign in with their user ID); rescuers use DEMO_PASSWORD.
 */
export const TEST_USERS = [
  { username: 'asha', role: 'victim', name: 'Asha Gurung', teamId: null, skills: [] },
  { username: 'ravi', role: 'rescuer', name: 'Ravi Shrestha (Team Alpha)', teamId: 'team-alpha', skills: ['boat', 'first_aid'] },
  { username: 'meena', role: 'rescuer', name: 'Meena Tamang (Team Bravo)', teamId: 'team-bravo', skills: ['medical', 'search'] },
  { username: 'kiran', role: 'rescuer', name: 'Kiran Rai (Team Charlie)', teamId: 'team-charlie', skills: ['boat', 'swimming', 'driving'] },
] as const;

export const TEST_ASHA_PROFILE = {
  name: 'Asha Gurung',
  contacts: [
    { name: 'Raju Gurung', phone: '+977 00000 00201', relation: 'son' },
    { name: 'Neighbour – Mina', phone: '+977 00000 00202', relation: 'neighbour' },
  ],
  details: { age: 68, phone: '+977 00000 00200', householdSize: 2, occupation: 'Retired teacher', medicalNotes: 'Type 2 diabetes – needs insulin', needs: ['elderly', 'medical'] as ('elderly' | 'medical')[] },
  updatedAt: '2026-07-01T00:00:00.000Z',
};

/** The general demo profiles of earlier versions – removed once from existing databases (decisions.md 12.13). */
export const OLD_DEMO_USERNAMES = ['asha', 'ravi', 'meena', 'kiran', 'demo-lakhi', 'demo-rahim', 'demo-joy'];

function insertUser(s: Services, u: { username: string; role: string; name: string; teamId: string | null; skills: readonly string[] }, password: string | null, profile = '{}') {
  if (s.db.prepare('SELECT 1 FROM users WHERE username = ?').get(u.username)) return;
  s.db
    .prepare('INSERT INTO users (id, username, password_hash, role, name, team_id, skills, profile, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), u.username, password ? hashPassword(password) : '', u.role, u.name, u.teamId, JSON.stringify(u.skills), profile, new Date().toISOString());
}

export function seedDemo(s: Services) {
  insertUser(s, ADMIN_USER, DEMO_PASSWORD);
  if (!s.latestSnapshot()) {
    s.setLiveStock(DEMO_STOCK, 'seed');
    s.setSites(DEMO_SITES, 'seed');
    s.publishSnapshot('seed');
  }
}

/**
 * Idempotent Phase 2 seed – also upgrades older databases in place:
 *  - shelter details and the sample found-person registry (if missing)
 *  - ONE-TIME: delete the old general demo profiles (everyone except admin) and move a
 *    database still holding the old Guwahati sample to the Kathmandu sample.
 */
export function seedPhase2(s: Services) {
  if (!kvGet(s.db, 'cleanup.demoUsers.v1')) {
    const del = s.db.prepare('DELETE FROM users WHERE username = ? AND role != ?');
    let removed = 0;
    for (const u of OLD_DEMO_USERNAMES) removed += Number(del.run(u, 'admin').changes);
    kvSet(s.db, 'cleanup.demoUsers.v1', new Date().toISOString());
    if (removed) s.audit('system', 'seed.demo_users_removed', 'users', { removed });
  }
  if (!kvGet(s.db, 'sample.region') || kvGet(s.db, 'sample.region') !== 'kathmandu') {
    const oldSample = s.sites().some((x) => x.lat < 27 && x.id.startsWith('shelter-'));
    if (oldSample || !s.sites().length) {
      s.setSites(DEMO_SITES, 'seed');
      s.publishSnapshot('seed');
      kvSet(s.db, 'shelterDetails', JSON.stringify(DEMO_SHELTER_DETAILS));
      s.db.prepare('DELETE FROM found_persons').run();
    }
    kvSet(s.db, 'sample.region', 'kathmandu');
  }
  if (!kvGet(s.db, 'shelterDetails')) kvSet(s.db, 'shelterDetails', JSON.stringify(DEMO_SHELTER_DETAILS));
  const reg = (s.db.prepare('SELECT COUNT(*) AS n FROM found_persons').get() as { n: number }).n;
  if (reg === 0) for (const f of DEMO_FOUND_PERSONS) s.db.prepare('INSERT INTO found_persons (id, data) VALUES (?, ?)').run(f.id, JSON.stringify(f));
}

/** Test fixtures (see TEST_USERS). */
export function seedTestUsers(s: Services) {
  for (const u of TEST_USERS) insertUser(s, u, u.role === 'victim' ? null : DEMO_PASSWORD, u.username === 'asha' ? JSON.stringify(TEST_ASHA_PROFILE) : '{}');
}
