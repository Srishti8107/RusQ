/**
 * Location with last-known fallback (§4). GPS works without mobile data.
 * The last fix is saved on every successful fix, on the online/offline events
 * and on app open; when live location fails we use it and SAY SO ("Last known
 * location, X ago").
 */
import { isNativeApp } from './platform.ts';
import { kvGet, kvSet, K } from './db.ts';

export interface Fix {
  lat: number;
  lng: number;
  accuracy: number;
  at: string;
}

export interface LocationResult {
  fix: Fix | null;
  source: 'live' | 'last_known' | 'manual' | 'none';
  error?: string;
}

/**
 * Position timestamps are not reliable across engines (WebKit returned a value that
 * was not epoch-ms, giving an out-of-range date the server rejected). Accept the
 * fix time only if it is plausible (within 24 h of now), else use now.
 */
export function fixTime(ts: number | undefined, nowMs = Date.now()): string {
  return typeof ts === 'number' && Number.isFinite(ts) && Math.abs(nowMs - ts) < 86_400_000 ? new Date(ts).toISOString() : new Date(nowMs).toISOString();
}

export async function lastKnown(): Promise<Fix | null> {
  return (await kvGet<Fix>(K.lastLocation)) ?? null;
}

async function save(f: Fix) {
  await kvSet(K.lastLocation, f);
}

/** Android app: Android's own location service (Capacitor Geolocation) – the WebView route could hang. */
async function nativePosition(timeoutMs: number, maximumAgeMs: number): Promise<Fix> {
  const { Geolocation } = await import('@capacitor/geolocation');
  const hard = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Location timed out.')), timeoutMs + 2000));
  const p = await Promise.race([Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: timeoutMs, maximumAge: maximumAgeMs }), hard]);
  return { lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), accuracy: Math.round(p.coords.accuracy), at: fixTime(p.timestamp) };
}

function livePosition(timeoutMs: number, maximumAgeMs: number): Promise<Fix> {
  if (isNativeApp) return nativePosition(timeoutMs, maximumAgeMs);
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('This phone has no location support.'));
    // hard limit: settles even if a permission prompt never appears or is never answered
    const hard = setTimeout(() => reject(new Error('Location timed out.')), timeoutMs + 2000);
    const done = <T,>(f: (v: T) => void) => (v: T) => (clearTimeout(hard), f(v));
    navigator.geolocation.getCurrentPosition(
      done((p: GeolocationPosition) =>
        resolve({
          lat: +p.coords.latitude.toFixed(6),
          lng: +p.coords.longitude.toFixed(6),
          accuracy: Math.round(p.coords.accuracy),
          at: fixTime(p.timestamp),
        }),
      ),
      done((e: GeolocationPositionError) => reject(new Error(e.code === e.PERMISSION_DENIED ? 'Location permission is off.' : e.code === e.TIMEOUT ? 'Location timed out.' : 'Location unavailable.'))),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: maximumAgeMs },
    );
  });
}

/** Live fix if possible, else the last known fix, else none. Never throws. */
export async function getLocation(timeoutMs = 8000): Promise<LocationResult> {
  try {
    const fix = await livePosition(timeoutMs, 30_000);
    await save(fix);
    return { fix, source: 'live' };
  } catch (e) {
    const last = await lastKnown();
    return { fix: last, source: last ? 'last_known' : 'none', error: (e as Error).message };
  }
}

/** Quietly refresh the saved fix (app open, online/offline events). */
export async function refreshLastKnown() {
  try {
    await save(await livePosition(10_000, 120_000));
  } catch {
    /* keep previous */
  }
}

export function startLocationKeeper() {
  void refreshLastKnown();
  window.addEventListener('online', () => void refreshLastKnown());
  window.addEventListener('offline', () => void refreshLastKnown());
}

export function agoText(iso: string, nowMs = Date.now()): string {
  const s = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} seconds ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return `${Math.round(h / 24)} days ago`;
}

export async function permissionState(): Promise<PermissionState | 'unsupported'> {
  try {
    return (await navigator.permissions.query({ name: 'geolocation' })).state;
  } catch {
    return 'unsupported';
  }
}
