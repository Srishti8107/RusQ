/**
 * Victim registration + profile (Phase 2, §3 step 1, §4 victim app).
 * Stored on the phone (IndexedDB, works offline) AND on the server.
 * The SOS carries a compact copy so rescuers see who needs help and whom to call
 * even if the server's profile copy is out of date.
 */
import { z } from 'zod';
import { Contact } from './schemas.ts';

export const NEED_FLAGS = ['elderly', 'child', 'disability', 'pregnant', 'medical', 'pet'] as const;
export type NeedFlag = (typeof NEED_FLAGS)[number];

export const NEED_LABELS: Record<NeedFlag, string> = {
  elderly: 'Elderly person (65+)',
  child: 'Young child',
  disability: 'Disability / cannot walk far',
  pregnant: 'Pregnant',
  medical: 'Needs regular medicine / medical care',
  pet: 'Pets or livestock',
};

export const ProfileDetails = z.object({
  age: z.number().int().min(0).max(130).optional(),
  phone: z.string().trim().max(32).optional(),
  address: z.string().trim().max(200).optional(),
  language: z.string().trim().max(30).optional(),
  /** total number of people living in the house (including the person) */
  householdSize: z.number().int().min(1).max(50).optional(),
  /** work: what the person does and where (helps rescuers find people during working hours) */
  occupation: z.string().trim().max(80).optional(),
  workplace: z.string().trim().max(200).optional(),
  medicalNotes: z.string().trim().max(500).optional(),
  needs: z.array(z.enum(NEED_FLAGS)).max(NEED_FLAGS.length).default([]),
});
export type ProfileDetails = z.infer<typeof ProfileDetails>;

export const Profile = z.object({
  name: z.string().trim().min(1).max(80),
  contacts: z.array(Contact).max(5).default([]),
  details: ProfileDetails.default({}),
  updatedAt: z.string().datetime({ offset: true }),
});
export type Profile = z.infer<typeof Profile>;

export const USERNAME_RE = /^[a-z0-9_.-]{3,32}$/;

/**
 * Victim self-registration: a USER ID only – no username, no password (owner's decision, see
 * decisions.md 12.2). The user ID is what the person types to sign in again.
 */
export const Registration = z.object({
  userId: z.string().trim().toLowerCase().regex(USERNAME_RE, 'use 3–32 letters, numbers, dot, dash or underscore'),
  profile: Profile.omit({ updatedAt: true }),
});
export type Registration = z.infer<typeof Registration>;

/** Admin creates rescuer / admin accounts (victims self-register). */
export const SKILLS = ['boat', 'swimming', 'first_aid', 'medical', 'search', 'heavy_equipment', 'driving'] as const;
export type Skill = (typeof SKILLS)[number];
export const SKILL_LABELS: Record<Skill, string> = {
  boat: 'Boat handling',
  swimming: 'Water rescue / swimming',
  first_aid: 'First aid',
  medical: 'Medical (doctor / nurse)',
  search: 'Search & rescue (collapse)',
  heavy_equipment: 'Heavy equipment',
  driving: 'Driving / transport',
};

export const StaffAccount = z.object({
  username: z.string().trim().toLowerCase().regex(USERNAME_RE),
  password: z.string().min(8).max(200),
  name: z.string().trim().min(1).max(80),
  role: z.enum(['rescuer', 'admin']),
  teamId: z.string().trim().regex(/^[a-z0-9-]{2,40}$/, 'lower-case letters, numbers and dashes').nullable().default(null),
  skills: z.array(z.enum(SKILLS)).max(SKILLS.length).default([]),
});
export type StaffAccount = z.infer<typeof StaffAccount>;

/** A random, easy-to-read user ID suggestion, e.g. "np-4k7m2q" (no 0/o/1/l to avoid mix-ups). */
export function suggestUserId(rand: () => number = Math.random): string {
  const a = '23456789abcdefghjkmnpqrstuvwxyz';
  let s = 'np-';
  for (let i = 0; i < 6; i++) s += a[Math.floor(rand() * a.length)];
  return s;
}

/** The compact profile attached to every SOS. */
export function sosProfileFrom(p: Pick<Profile, 'name' | 'contacts' | 'details'>) {
  const d = p.details ?? { needs: [] };
  return {
    name: p.name,
    contacts: p.contacts,
    medicalNotes: d.medicalNotes || undefined,
    age: d.age,
    phone: d.phone || undefined,
    householdSize: d.householdSize,
    needs: d.needs?.length ? d.needs : undefined,
    occupation: d.occupation || undefined,
    workplace: d.workplace || undefined,
  };
}

/** Vulnerability used by SOS triage (age < 12 or ≥ 65, or a need flag other than pets). */
export function isVulnerable(p: { age?: number; needs?: readonly string[] } | undefined): boolean {
  if (!p) return false;
  if (p.age !== undefined && (p.age < 12 || p.age >= 65)) return true;
  return (p.needs ?? []).some((n) => n === 'elderly' || n === 'child' || n === 'disability' || n === 'pregnant');
}

export function hasMedicalNeed(p: { medicalNotes?: string; needs?: readonly string[] } | undefined): boolean {
  if (!p) return false;
  return !!p.medicalNotes?.trim() || (p.needs ?? []).includes('medical');
}
