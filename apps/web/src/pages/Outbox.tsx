/** Everything this phone created, with its TRUE delivery status (§2.1). */
import { useState } from 'react';
import { isDelivered, type FieldReport, type Sos, type Allotment } from '@rusq/shared';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { usePhotos, useOutbox, useReach } from '../lib/hooks.ts';
import { syncNow, type SyncResult } from '../lib/sync.ts';

export function OutboxPage() {
  const rows = useOutbox();
  const photos = usePhotos();
  const reach = useReach();
  const [last, setLast] = useState<SyncResult | null>(null);
  const [busy, setBusy] = useState(false);
  const waiting = rows.filter((r) => !isDelivered(r)).length + photos.filter((p) => !isDelivered(p)).length;

  async function retry() {
    setBusy(true);
    setLast(await syncNow('manual'));
    setBusy(false);
  }

  return (
    <div>
      <h1>Sent & waiting</h1>
      <div className="card">
        <p>
          <strong>{waiting}</strong> waiting for the control room · <strong>{rows.length + photos.length - waiting}</strong> confirmed.
        </p>
        <p className="small muted">“Received” is shown only after the control room has replied with a reference number.</p>
        <button className="btn" onClick={retry} disabled={busy || reach !== 'online'} data-testid="sync-now">
          {busy ? 'Sending…' : reach === 'online' ? 'Send now' : 'Offline – will send automatically'}
        </button>
        {last && (
          <p className="small" role="status">
            {last.skipped ? `Not sent: ${last.skipped}.` : `Tried ${last.attempted}, confirmed ${last.received}${last.failed ? `, ${last.failed} failed` : ''}${last.relayUploaded ? `, uploaded ${last.relayUploaded} for nearby phones` : ''}.`}
          </p>
        )}
      </div>

      {rows.length === 0 && <p>Nothing sent from this phone yet.</p>}
      {rows.map((r) => (
        <div className="card" key={r.id} data-testid="outbox-row" data-kind={r.kind} data-id={r.id}>
          <div className="row between">
            <strong>
              {r.kind === 'sos' ? '🆘 SOS' : r.kind === 'report' ? '📝 Field report' : '⚖️ Provisional allotment'}
            </strong>
            <span className="small muted">{new Date(r.createdAt).toLocaleString()}</span>
          </div>
          <Summary row={r} />
          <StatusBadge s={r} long />
        </div>
      ))}
      {photos.length > 0 && (
        <div className="card">
          <h3>Photos</h3>
          {photos.map((p) => (
            <div key={p.id} className="row between" style={{ marginBottom: 8 }} data-testid="outbox-photo">
              <span className="small">
                Photo {p.width}×{p.height} ({Math.round(p.bytes.byteLength / 1024)} KB)
              </span>
              <StatusBadge s={p} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Summary({ row }: { row: { kind: string; data: unknown } }) {
  if (row.kind === 'sos') {
    const s = row.data as Sos;
    return (
      <p className="small">
        {s.lat != null ? `Location ${s.lat.toFixed(4)}, ${s.lng!.toFixed(4)} (${s.locationSource === 'live' ? 'live' : 'last known'})` : 'No location'}
      </p>
    );
  }
  if (row.kind === 'report') {
    const r = row.data as FieldReport;
    return (
      <p className="small">
        {r.victimCount} people · urgency {r.urgency}/5 · {r.humanFinal.hazards.join(', ') || 'no hazard tags'} · {r.photos.length} photo(s)
      </p>
    );
  }
  const a = row.data as Allotment;
  return (
    <p className="small">
      Claim: {Object.entries(a.claim).filter(([, v]) => v).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(', ') || 'nothing'} · snapshot v{a.snapshotVersion}
    </p>
  );
}
