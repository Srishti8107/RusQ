/**
 * Administrator reconciliation (§8B, Phase 1 admin page): live stock vs the sum
 * of provisional claims from every device, open conflicts, and approve /
 * approve-reduced / reject per allotment. Decisions are final and audit-logged.
 */
import { useCallback, useEffect, useState } from 'react';
import { RESOURCE_KEYS, RESOURCES, type Allotment, type ResourceKey, type ResourceQty } from '@rusq/shared';
import { api, friendlyError } from '../lib/api.ts';
import { useReach } from '../lib/hooks.ts';

interface Rec {
  liveStock: ResourceQty;
  pendingTotals: ResourceQty;
  snapshotVersion: number | null;
  conflicts: { id: string; resource: ResourceKey; liveStock: number; claimed: number; overBy: number; allotmentIds: string[]; devices: string[]; status: string; resolution: string | null }[];
  allotments: (Allotment & { serverId: string; status: string; staleSnapshot: boolean; approvedClaim: ResourceQty | null; decidedBy: string | null; note: string | null })[];
}

export function AdminReconcile() {
  const reach = useReach();
  const [rec, setRec] = useState<Rec | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [audit, setAudit] = useState<{ id: string; actor: string; action: string; target: string; at: string }[]>([]);

  const load = useCallback(async () => {
    try {
      setRec(await api<Rec>('/admin/reconciliation'));
      setAudit(await api('/admin/audit'));
      setError(null);
    } catch (e) {
      setError(friendlyError(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(id: string, decision: 'approve' | 'reject', approvedClaim?: ResourceQty, note?: string) {
    try {
      await api(`/admin/allotments/${id}/decision`, { method: 'POST', body: JSON.stringify({ decision, approvedClaim, note }) });
      await load();
    } catch (e) {
      setError(friendlyError(e));
    }
  }

  if (reach === 'offline' && !rec) return <div className="banner warn">The control-room view needs a connection to the server.</div>;

  const open = rec?.conflicts.filter((c) => c.status === 'open') ?? [];
  const pending = rec?.allotments.filter((a) => a.status === 'pending') ?? [];
  const decided = rec?.allotments.filter((a) => a.status !== 'pending') ?? [];

  return (
    <div>
      <h1>Allotments & conflicts</h1>
      <p className="small muted">Phones compute provisional shares offline. Here you see them against live stock. Nothing changes until you decide.</p>
      {error && <div className="banner bad" role="alert">{error}</div>}
      <button className="btn secondary small" onClick={() => void load()}>
        Refresh
      </button>

      <div className="card table-wrap">
        <h2>Stock vs claims</h2>
        <table>
          <thead>
            <tr>
              <th>Resource</th>
              <th>Live stock</th>
              <th>Pending claims</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {RESOURCE_KEYS.filter((k) => (rec?.liveStock[k] ?? 0) > 0 || (rec?.pendingTotals[k] ?? 0) > 0).map((k) => {
              const over = (rec?.pendingTotals[k] ?? 0) > (rec?.liveStock[k] ?? 0);
              return (
                <tr key={k} style={over ? { background: 'var(--area-affected)' } : undefined}>
                  <td>{RESOURCES[k].label}</td>
                  <td>{rec?.liveStock[k] ?? 0}</td>
                  <td>{rec?.pendingTotals[k] ?? 0}</td>
                  <td>{over && <strong style={{ color: 'var(--sos)' }}>OVER by {(rec?.pendingTotals[k] ?? 0) - (rec?.liveStock[k] ?? 0)}</strong>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="card" data-testid="conflicts">
        <h2>Open conflicts ({open.length})</h2>
        {open.length === 0 && <p>No conflicts. All pending claims fit the live stock.</p>}
        {open.map((c) => (
          <div key={c.id} className="banner bad" data-testid="conflict">
            <strong>{RESOURCES[c.resource].label}</strong>: devices claimed {c.claimed}, only {c.liveStock} in stock (over by {c.overBy}). Devices: {c.devices.join(', ')}.
            Decide on the allotments below.
          </div>
        ))}
      </div>

      <h2>Pending allotments ({pending.length})</h2>
      {pending.map((a) => (
        <AllotmentCard key={a.id} a={a} onDecide={decide} />
      ))}

      {decided.length > 0 && (
        <div className="card table-wrap">
          <h2>Decided</h2>
          <table>
            <thead>
              <tr>
                <th>Ref</th>
                <th>Device</th>
                <th>Decision</th>
                <th>Approved</th>
              </tr>
            </thead>
            <tbody>
              {decided.map((a) => (
                <tr key={a.id}>
                  <td>{a.serverId}</td>
                  <td>{a.deviceId}</td>
                  <td>{a.status}</td>
                  <td>{a.approvedClaim ? fmt(a.approvedClaim) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h2>Audit log</h2>
        <ul className="small" style={{ maxHeight: 260, overflow: 'auto' }}>
          {audit.slice(0, 50).map((e) => (
            <li key={e.id}>
              {new Date(e.at).toLocaleTimeString()} · <strong>{e.action}</strong> · {e.target.slice(0, 18)} · by {e.actor.slice(0, 12)}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function AllotmentCard({ a, onDecide }: { a: Rec['allotments'][number]; onDecide: (id: string, d: 'approve' | 'reject', c?: ResourceQty, note?: string) => void }) {
  const [claim, setClaim] = useState<ResourceQty>(a.claim);
  const [note, setNote] = useState('');
  return (
    <div className="card" data-testid="allotment" data-id={a.id}>
      <div className="row between">
        <strong>
          {a.serverId} · device {a.deviceId}
        </strong>
        <span className="small">
          snapshot v{a.snapshotVersion} {a.staleSnapshot && <span className="label-exp">OLD SNAPSHOT</span>}
        </span>
      </div>
      <p className="small">Provisional claim from the device (you may lower it):</p>
      <div className="grid2">
        {RESOURCE_KEYS.filter((k) => (a.claim[k] ?? 0) > 0).map((k) => (
          <label className="field" key={k}>
            {RESOURCES[k].label} (asked {a.claim[k]})
            <input inputMode="numeric" value={claim[k] ?? 0} onChange={(e) => setClaim({ ...claim, [k]: Math.min(a.claim[k] ?? 0, Math.max(0, parseInt(e.target.value || '0', 10))) })} />
          </label>
        ))}
      </div>
      <label className="field">
        Note (optional)
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="row">
        <button className="btn" onClick={() => onDecide(a.id, 'approve', claim, note || undefined)} data-testid="approve">
          ✔ Approve
        </button>
        <button className="btn danger secondary" onClick={() => onDecide(a.id, 'reject', undefined, note || undefined)} data-testid="reject">
          ✖ Reject
        </button>
      </div>
    </div>
  );
}

function fmt(q: ResourceQty) {
  return Object.entries(q)
    .filter(([, v]) => v)
    .map(([k, v]) => `${RESOURCES[k as ResourceKey].label} ${v}`)
    .join(', ');
}
