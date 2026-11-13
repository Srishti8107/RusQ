/** React hooks over the lib modules (kept separate so the service-worker bundle stays React-free). */
import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { db, type OutboxRow, type PhotoRow } from './db.ts';
import { currentReach, onReachChange, type Reach } from './connectivity.ts';
import { getSession, onSessionChange, type Session } from './session.ts';

export function useLive<T>(fn: () => Promise<T>, deps: unknown[], initial: T): T {
  const [v, setV] = useState<T>(initial);
  useEffect(() => {
    const sub = liveQuery(fn).subscribe({ next: setV, error: () => {} });
    return () => sub.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return v;
}

export function useOutbox(): OutboxRow[] {
  return useLive(() => db.outbox.orderBy('createdAt').reverse().toArray(), [], []);
}

export function usePhotos(reportId?: string): PhotoRow[] {
  return useLive(() => (reportId ? db.photos.where('reportId').equals(reportId).toArray() : db.photos.toArray()), [reportId], []);
}

export function useReach(): Reach {
  const [r, setR] = useState<Reach>(currentReach());
  useEffect(() => onReachChange(setR), []);
  return r;
}

export function useSession(): Session | null | undefined {
  const [s, setS] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    void getSession().then(setS);
    return onSessionChange(setS);
  }, []);
  return s;
}

/** Re-render every `ms` (for "X minutes ago" labels). */
export function useNow(ms = 30_000): number {
  const [n, setN] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setN(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return n;
}
