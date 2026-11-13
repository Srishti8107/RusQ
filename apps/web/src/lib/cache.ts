/**
 * Read-through cache for server views (dashboard, SOS monitor, tasks,
 * announcements…). Online: fetch and save a copy in IndexedDB. Offline: show
 * the saved copy WITH its age ("Saved 12 minutes ago") – never presented as live.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, friendlyError } from './api.ts';
import { kvGet, kvSet } from './db.ts';
import { useReach } from './hooks.ts';

interface Cached<T> {
  at: string;
  data: T;
}

const key = (path: string) => `cache:${path}`;

export async function cachedGet<T>(path: string): Promise<{ data: T; at: string; live: boolean }> {
  try {
    const data = await api<T>(path, { timeoutMs: 12_000 });
    const at = new Date().toISOString();
    await kvSet<Cached<T>>(key(path), { at, data }).catch(() => {});
    return { data, at, live: true };
  } catch (e) {
    if (e instanceof ApiError && e.status !== 0) throw e; // a real server answer (403, 500…) – don't hide it
    const c = await kvGet<Cached<T>>(key(path));
    if (c) return { data: c.data, at: c.at, live: false };
    throw e;
  }
}

export interface CachedState<T> {
  data: T | null;
  at: string | null;
  live: boolean;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
}

export function useCachedApi<T>(path: string | null, refreshMs = 0): CachedState<T> {
  const reach = useReach();
  const [s, setS] = useState<Omit<CachedState<T>, 'reload'>>({ data: null, at: null, live: false, error: null, loading: true });

  const reload = useCallback(async () => {
    if (!path) return;
    setS((p) => ({ ...p, loading: true }));
    try {
      const r = await cachedGet<T>(path);
      setS({ data: r.data, at: r.at, live: r.live, error: null, loading: false });
    } catch (e) {
      // show what we had before, if anything
      const c = await kvGet<Cached<T>>(key(path));
      setS({ data: c?.data ?? null, at: c?.at ?? null, live: false, error: friendlyError(e), loading: false });
    }
  }, [path]);

  useEffect(() => {
    void reload();
  }, [reload, reach]);

  // Control-room screens refresh at once when something new arrived (adminfeed.ts).
  useEffect(() => {
    if (!path?.startsWith('/admin')) return;
    const on = () => void reload();
    window.addEventListener('rusq:admin-feed', on);
    return () => window.removeEventListener('rusq:admin-feed', on);
  }, [path, reload]);

  useEffect(() => {
    if (!refreshMs) return;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, refreshMs);
    return () => clearInterval(t);
  }, [reload, refreshMs]);

  return { ...s, reload };
}
