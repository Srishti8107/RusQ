/**
 * What the WEBSITE offers (server setting, GET /api/config):
 *  - default: only the control room; people needing help and rescuers are asked to install the
 *    Android app (it can link phones without internet – browsers cannot);
 *  - webFieldRoles = true: field roles may also use the website (iPhones, tests).
 * The Android app ignores this – it is the field app.
 */
import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { isNativeApp } from './platform.ts';

export interface WebPolicy {
  webFieldRoles: boolean;
  apk: string | null;
}

const KEY = 'rusq.webPolicy';
function cached(): WebPolicy | null {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null') as WebPolicy | null;
  } catch {
    return null;
  }
}

let current: WebPolicy | null = cached();
let loading: Promise<WebPolicy | null> | null = null;

export function loadWebPolicy(): Promise<WebPolicy | null> {
  loading ??= api<WebPolicy>('/config', { auth: false, timeoutMs: 6000 })
    .then((p) => {
      current = p;
      try {
        localStorage.setItem(KEY, JSON.stringify(p));
      } catch {
        /* not kept */
      }
      return p;
    })
    .catch(() => current)
    .finally(() => (loading = null));
  return loading;
}

/** null while unknown (first visit, no connection yet). */
export function useWebPolicy(): WebPolicy | null {
  const [p, setP] = useState<WebPolicy | null>(current);
  useEffect(() => {
    void loadWebPolicy().then((x) => x && setP(x));
  }, []);
  return p;
}

/** True when this role should be sent to the app instead of using the website. */
export function fieldRoleBlockedOnWeb(role: string | undefined, p: WebPolicy | null): boolean {
  if (isNativeApp || !role || role === 'admin') return false;
  return !(p?.webFieldRoles ?? false);
}
