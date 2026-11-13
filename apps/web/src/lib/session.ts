/** Session (token + user), stable device id, and settings – all in IndexedDB so they work offline. */
import { uuidv7, type Role } from '@rusq/shared';
import { kvDel, kvGet, kvSet, K } from './db.ts';

export interface Session {
  token: string;
  user: { id: string; username: string; role: Role; name: string; teamId: string | null };
}

let cached: Session | null | undefined;
const listeners = new Set<(s: Session | null) => void>();

export async function getSession(): Promise<Session | null> {
  if (cached !== undefined) return cached;
  cached = (await kvGet<Session>(K.session)) ?? null;
  return cached;
}

export async function setSession(s: Session | null) {
  cached = s;
  if (s) await kvSet(K.session, s);
  else await kvDel(K.session);
  for (const l of listeners) l(s);
}

export function onSessionChange(l: (s: Session | null) => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export async function getDeviceId(): Promise<string> {
  let id = await kvGet<string>(K.deviceId);
  if (!id) {
    id = `dev-${uuidv7().slice(-12)}`;
    await kvSet(K.deviceId, id);
  }
  return id;
}

export interface Settings {
  /** disables automatic vision and heavy models (§5 battery) */
  lowPower: boolean;
  /** hours after which the snapshot is shown as stale */
  staleHours: number;
  /** force the deterministic MOCK vision backend (testing/demo only) */
  visionMock: boolean;
  /** OPTIONAL on-device AI writing helper (Llama 3.2 1B, WebGPU). Off by default. */
  assistant: boolean;
  /** phone numbers rescuer short codes are sent to by SMS (control-room gateway, other rescuers) */
  smsNumbers: string;
}

export const DEFAULT_SETTINGS: Settings = { lowPower: false, staleHours: 6, visionMock: false, assistant: false, smsNumbers: '' };

export async function getSettings(): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...((await kvGet<Partial<Settings>>(K.settings)) ?? {}) };
}

export async function saveSettings(s: Partial<Settings>) {
  await kvSet(K.settings, { ...(await getSettings()), ...s });
}
