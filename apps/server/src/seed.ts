/**
 * Demo seed for the flood scenario (sample data – fictional people and shelter
 * names, real-world coordinates around Guwahati, Assam, a flood-prone city).
 * Idempotent: only seeds an empty database.
 */
import { randomUUID } from 'node:crypto';
import type { Site } from '@rusq/shared';
import { hashPassword } from './auth.ts';
import type { Services } from './services.ts';

export const DEMO_PASSWORD = 'demo1234';

export const DEMO_USERS = [
  { username: 'asha', role: 'victim', name: 'Asha Devi', teamId: null, skills: [] },
  { username: 'ravi', role: 'rescuer', name: 'Ravi Das (Team Alpha)', teamId: 'team-alpha', skills: ['boat', 'first_aid'] },
  { username: 'meena', role: 'rescuer', name: 'Meena Bora (Team Bravo)', teamId: 'team-bravo', skills: ['medical', 'search'] },
  { username: 'admin', role: 'admin', name: 'District Control Room', teamId: null, skills: [] },
] as const;

export const DEMO_SITES: Site[] = [
  { id: 'shelter-01', kind: 'shelter', name: 'Govt. Higher Secondary School, Chandmari', lat: 26.1856, lng: 91.7681, density: 320, urgency: 1, needs: { food_water: 400, medical_supplies: 20, clothing_blankets: 150, first_aid_kits: 10 }, capacity: 500 },
  { id: 'shelter-02', kind: 'shelter', name: 'Community Hall, Anil Nagar', lat: 26.1712, lng: 91.7834, density: 210, urgency: 2, needs: { food_water: 300, clothing_blankets: 120, medical_supplies: 10 }, capacity: 260 },
  { id: 'shelter-03', kind: 'shelter', name: 'Stadium Relief Camp, Sarusajai', lat: 26.1205, lng: 91.7623, density: 640, urgency: 1, needs: { food_water: 800, medical_supplies: 40, clothing_blankets: 300, first_aid_kits: 25, transportation: 2 }, capacity: 1200 },
  { id: 'shelter-04', kind: 'shelter', name: 'Temple Guest House, Maligaon', lat: 26.1554, lng: 91.6955, density: 90, urgency: 1, needs: { food_water: 120, clothing_blankets: 40 }, capacity: 150 },
  { id: 'shelter-05', kind: 'shelter', name: 'Primary School, Zoo Road', lat: 26.1626, lng: 91.7799, density: 150, urgency: 3, needs: { food_water: 200, medical_supplies: 15, boats: 1, rescue_equipment: 4 }, capacity: 200 },
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

export function seedDemo(s: Services) {
  const n = (s.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  if (n > 0) return;
  const now = new Date().toISOString();
  for (const u of DEMO_USERS) {
    s.db
      .prepare('INSERT INTO users (id, username, password_hash, role, name, team_id, skills, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), u.username, hashPassword(DEMO_PASSWORD), u.role, u.name, u.teamId, JSON.stringify(u.skills), now);
  }
  s.setLiveStock(DEMO_STOCK, 'seed');
  s.setSites(DEMO_SITES, 'seed');
  s.publishSnapshot('seed');
}
