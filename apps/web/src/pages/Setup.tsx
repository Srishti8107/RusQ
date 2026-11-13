/** "Ready for offline" (§5): sizes, a checklist that turns green only after VERIFYING storage, storage use. */
import { useCallback, useEffect, useState } from 'react';
import { useReach, useSession } from '../lib/hooks.ts';
import { CHECKLIST, mb, storageEstimate, type ItemId } from '../lib/setup.ts';
import { StorageFullError, isQuotaError } from '../lib/db.ts';

interface ItemState {
  ok: boolean;
  detail: string;
  size: number | null;
  busy: boolean;
  progress?: string;
  error?: string;
}

export function Setup() {
  const session = useSession();
  const reach = useReach();
  const role = session?.user.role ?? 'victim';
  const items = CHECKLIST.filter((i) => i.roles.includes(role));
  const [state, setState] = useState<Record<string, ItemState>>({});
  const [est, setEst] = useState<{ usage: number; quota: number } | null>(null);
  const [busyAll, setBusyAll] = useState(false);

  const verifyAll = useCallback(async () => {
    const next: Record<string, ItemState> = {};
    for (const it of items) {
      const v = await it.verify().catch((e) => ({ ok: false, detail: (e as Error).message }));
      const size = it.sizeBytes ? await it.sizeBytes().catch(() => null) : null;
      next[it.id] = { ...v, size, busy: false };
    }
    setState(next);
    setEst(await storageEstimate());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  useEffect(() => {
    void verifyAll();
  }, [verifyAll]);

  async function run(id: ItemId) {
    const it = items.find((i) => i.id === id)!;
    setState((s) => ({ ...s, [id]: { ...(s[id] ?? { ok: false, detail: '', size: null }), busy: true, error: undefined, progress: 'Starting…' } }));
    try {
      await it.download?.((msg) => setState((s) => ({ ...s, [id]: { ...s[id]!, progress: msg } })));
    } catch (e) {
      const msg = e instanceof StorageFullError || isQuotaError(e) ? new StorageFullError().message : (e as Error).message;
      setState((s) => ({ ...s, [id]: { ...s[id]!, busy: false, error: msg, progress: undefined } }));
      return;
    }
    const v = await it.verify().catch((e) => ({ ok: false, detail: (e as Error).message }));
    const size = it.sizeBytes ? await it.sizeBytes().catch(() => null) : null;
    setState((s) => ({ ...s, [id]: { ...v, size, busy: false } }));
    setEst(await storageEstimate());
  }

  async function runAll() {
    setBusyAll(true);
    for (const it of items) if (!state[it.id]?.ok) await run(it.id);
    setBusyAll(false);
  }

  const done = items.filter((i) => state[i.id]?.ok).length;

  return (
    <div>
      <h1>Ready for offline</h1>
      <p>Do this while you still have internet. Each line turns green only after RusQ has checked it is really saved on this phone.</p>
      {reach !== 'online' && <div className="banner warn">You are offline. Items already green will keep working. Grey items need internet to download.</div>}

      <div className="card" aria-live="polite">
        <div className="row between">
          <strong data-testid="setup-progress">
            {done} of {items.length} ready
          </strong>
          <button className="btn" onClick={runAll} disabled={busyAll || reach !== 'online'} data-testid="setup-all">
            {busyAll ? 'Downloading…' : 'Download everything'}
          </button>
        </div>
        <div className="meter" style={{ marginTop: 10 }} aria-hidden="true">
          <span style={{ width: `${(100 * done) / Math.max(1, items.length)}%` }} />
        </div>
      </div>

      {items.map((it) => {
        const s = state[it.id];
        return (
          <div className="card" key={it.id} data-testid={`setup-${it.id}`} data-ok={!s ? 'pending' : s.ok ? 'yes' : 'no'}>
            <div className="row between">
              <h3 style={{ margin: 0 }}>
                <span aria-hidden="true">{s?.ok ? '🟢' : '⚪'}</span> {it.label}
              </h3>
              <span className={`status ${s?.ok ? 'received' : 'queued'}`}>{s?.ok ? 'Ready' : 'Not ready'}</span>
            </div>
            <p className="small muted">{it.why}</p>
            <div className="row between small">
              <span>{s?.busy ? s.progress : s?.detail}</span>
              {s?.size != null && <span>Size: {mb(s.size)}</span>}
            </div>
            {s?.error && (
              <div className="banner bad" role="alert">
                {s.error}
              </div>
            )}
            {!s?.ok && (
              <button className="btn secondary small" onClick={() => void run(it.id)} disabled={!!s?.busy || (reach !== 'online' && it.id !== 'location' && it.id !== 'storage')}>
                {s?.busy ? 'Working…' : 'Download / allow'}
              </button>
            )}
          </div>
        );
      })}

      <div className="card">
        <h3>Storage on this phone</h3>
        {est ? (
          <>
            <p>
              RusQ uses <strong>{mb(est.usage)}</strong> of <strong>{mb(est.quota)}</strong> available to it.
            </p>
            <div className="meter" aria-hidden="true">
              <span style={{ width: `${Math.min(100, (100 * est.usage) / Math.max(1, est.quota))}%` }} />
            </div>
          </>
        ) : (
          <p>Storage information is not available in this browser.</p>
        )}
        <button className="btn secondary small" onClick={() => void verifyAll()} style={{ marginTop: 10 }}>
          Check again
        </button>
      </div>

      <div className="card small">
        <strong>iPhone users:</strong> iPhones may delete saved app data if RusQ is not opened for a few weeks. Open RusQ at least once a week before the
        monsoon season, and check this page shows everything green.
      </div>
    </div>
  );
}
