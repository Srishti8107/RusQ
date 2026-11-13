/** Small shared pieces for the control-room screens. */
import { useEffect, useState } from 'react';
import { api, friendlyError } from '../lib/api.ts';
import type { CachedState } from '../lib/cache.ts';
import { getSession } from '../lib/session.ts';
import { useNow, useReach } from '../lib/hooks.ts';
import { agoText } from '../lib/location.ts';

/** "Live" vs "saved copy from X ago" + refresh. Actions are disabled offline (decisions must reach the server to be final and audited). */
export function Freshness({ q }: { q: CachedState<unknown> }) {
  const reach = useReach();
  const now = useNow(15_000);
  return (
    <div className="row between" style={{ margin: '6px 0' }}>
      <span className="small" data-testid="freshness" data-live={q.live ? 'yes' : 'no'}>
        {q.loading ? 'Loading…' : q.live ? `Live – updated ${q.at ? agoText(q.at, now) : ''}` : q.at ? `⚠ Offline – showing data saved ${agoText(q.at, now)}` : ''}
      </span>
      <button className="btn secondary small" onClick={() => void q.reload()} disabled={reach !== 'online'}>
        Refresh
      </button>
      {q.error && !q.data && (
        <div className="banner bad" role="alert" style={{ width: '100%' }}>
          {q.error === 'network unreachable' ? 'No connection and nothing saved on this phone yet.' : q.error}
        </div>
      )}
    </div>
  );
}

export function OfflineActionsNote() {
  const reach = useReach();
  if (reach === 'online') return null;
  return <div className="banner warn">You are offline. You can read saved data, but decisions need a connection so they are recorded in the audit log.</div>;
}

export function SevBadge({ s }: { s: string }) {
  return <span className={`sev ${s}`}>{s.toUpperCase()}</span>;
}

/** POST/PUT helper: returns an error message or null, then reloads. */
export function useAction(reload: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(path: string, body: unknown, method: 'POST' | 'PUT' = 'POST') {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method, body: JSON.stringify(body) });
      await reload();
      return true;
    } catch (e) {
      setError(friendlyError(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { run, busy, error, setError };
}

const PHOTO_CACHE = 'rusq-admin-photos';

/** A report photo: fetched with the admin token, kept in the Cache API so it shows offline too. */
export function AuthImage({ id, alt }: { id: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const key = `/api/photos/${id}`;
        const cache = await caches.open(PHOTO_CACHE);
        let res = await cache.match(key);
        if (!res) {
          const s = await getSession();
          const net = await fetch(key, { headers: { authorization: `Bearer ${s?.token}` } });
          if (!net.ok) throw new Error(String(net.status));
          await cache.put(key, net.clone());
          res = net;
        }
        url = URL.createObjectURL(await res.blob());
        if (!cancelled) setSrc(url);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id]);
  if (failed) return <span className="small muted">Photo not received yet</span>;
  return src ? <img src={src} alt={alt} /> : <span className="small muted">Loading photo…</span>;
}

/** How a record reached the server: direct, or through how many phones and whose phone uploaded it (decisions.md 13.3). */
export function relayText(r: { via: string; relayHops?: number | null; relayGateway?: string | null }): string {
  if (r.via !== 'relay') return 'direct upload';
  if (r.relayHops === null || r.relayHops === undefined) return 'phone-to-phone relay';
  return `phone-to-phone relay – ${r.relayHops} hop${r.relayHops === 1 ? '' : 's'} between phones, uploaded by ${r.relayGateway ?? 'a nearby phone'}`;
}
