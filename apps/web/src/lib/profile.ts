/**
 * Profile (Phase 2): saved on THIS PHONE first (works offline), then uploaded.
 * Honest status: "Saved on this phone only" until the server confirms; the SOS
 * always carries the local copy, so contacts reach rescuers even if the
 * profile upload never happened.
 */
import { Profile, sosProfileFrom } from '@rusq/shared';
import { api } from './api.ts';
import { kvGet, kvSet, K } from './db.ts';

export async function getLocalProfile(): Promise<Profile | null> {
  const p = await kvGet<Profile>(K.profile);
  return p && Profile.safeParse(p).success ? p : null;
}

/** Save locally and mark for upload. Throws on invalid input (zod). */
export async function saveLocalProfile(p: Omit<Profile, 'updatedAt'>): Promise<Profile> {
  const full = Profile.parse({ ...p, updatedAt: new Date().toISOString() });
  await kvSet(K.profile, full);
  await kvSet(K.profileDirty, true);
  void uploadProfileIfDirty();
  return full;
}

export async function profileSyncState(): Promise<{ dirty: boolean; savedAt: string | null }> {
  return { dirty: (await kvGet<boolean>(K.profileDirty)) === true, savedAt: (await kvGet<string>(K.profileSavedAt)) ?? null };
}

let uploading: Promise<boolean> | null = null;

/** Called by the sync engine; resolves true when the server confirmed the current local copy. */
export function uploadProfileIfDirty(): Promise<boolean> {
  if (uploading) return uploading;
  uploading = (async () => {
    try {
      if (!(await kvGet<boolean>(K.profileDirty))) return false;
      const p = await getLocalProfile();
      if (!p) return false;
      const r = await api<{ savedAt: string; applied: boolean }>('/me/profile', { method: 'PUT', body: JSON.stringify(p), timeoutMs: 10_000 });
      const still = await getLocalProfile();
      if (still?.updatedAt === p.updatedAt) {
        await kvSet(K.profileDirty, false);
        await kvSet(K.profileSavedAt, r.savedAt);
      }
      if (!r.applied) await pullProfile(); // the server had a newer copy (edited on another phone)
      return true;
    } catch {
      return false;
    } finally {
      uploading = null;
    }
  })();
  return uploading;
}

/** After sign-in / registration: take the server copy unless a newer local edit is waiting. */
export async function pullProfile(): Promise<void> {
  try {
    const r = await api<{ profile: Profile | null }>('/me');
    const local = await getLocalProfile();
    const dirty = (await kvGet<boolean>(K.profileDirty)) === true;
    if (r.profile && (!local || !dirty || r.profile.updatedAt >= local.updatedAt)) {
      await kvSet(K.profile, r.profile);
      await kvSet(K.profileDirty, false);
      await kvSet(K.profileSavedAt, r.profile.updatedAt);
    }
  } catch {
    /* offline – keep the local copy */
  }
}

/** The compact copy attached to an SOS (falls back to the signed-in name). */
export async function sosProfile(fallbackName: string) {
  const p = await getLocalProfile();
  return p ? sosProfileFrom(p) : { name: fallbackName, contacts: [] };
}
