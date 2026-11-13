/** Rescue reports (§4, §10.3): photos, AI suggestion vs the rescuer's final answer, resource requests, and a comparison across locations. */
import { RESOURCE_KEYS, RESOURCES, kmText, type FieldReport, type ResourceKey } from '@rusq/shared';
import { useCachedApi } from '../../lib/cache.ts';
import { useNow } from '../../lib/hooks.ts';
import { agoText } from '../../lib/location.ts';
import { AuthImage, Freshness } from '../../components/AdminBits.tsx';
import { relayText } from '../../components/AdminBits.tsx';

type Row = FieldReport & { serverId: string; via: string; receivedAt: string; relayHops?: number | null; relayGateway?: string | null; shortCodeAt?: string | null; photosReceived: string[]; nearestShelter: { id: string; name: string; distanceM: number } | null };

export function AdminReports() {
  const q = useCachedApi<Row[]>('/admin/reports-view', 30_000);
  const now = useNow(30_000);
  const rows = q.data ?? [];
  const used = RESOURCE_KEYS.filter((k) => rows.some((r) => (r.humanFinal.requested[k] ?? 0) > 0));
  const total = (k: ResourceKey) => rows.reduce((n, r) => n + (r.humanFinal.requested[k] ?? 0), 0);

  return (
    <div>
      <h1>Field reports</h1>
      <Freshness q={q} />
      {rows.length === 0 && <p>No field reports received yet.</p>}

      {rows.length > 0 && (
        <div className="card table-wrap" data-testid="compare" tabIndex={0}>
          <h2>Requests compared across locations</h2>
          <table>
            <thead>
              <tr>
                <th>Report / place</th>
                <th>People</th>
                <th>Urgency</th>
                {used.map((k) => (
                  <th key={k}>{RESOURCES[k].label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span className="mono">{r.serverId}</span>
                    <br />
                    <span className="small">{r.nearestShelter ? `${kmText(r.nearestShelter.distanceM)} from ${r.nearestShelter.name}` : `${r.lat.toFixed(3)}, ${r.lng.toFixed(3)}`}</span>
                  </td>
                  <td>{r.humanFinal.victimCount}</td>
                  <td>{r.humanFinal.urgency}/5</td>
                  {used.map((k) => (
                    <td key={k}>{r.humanFinal.requested[k] ?? '–'}</td>
                  ))}
                </tr>
              ))}
              <tr>
                <th>Total</th>
                <th>{rows.reduce((n, r) => n + r.humanFinal.victimCount, 0)}</th>
                <th></th>
                {used.map((k) => (
                  <th key={k}>{total(k)}</th>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {rows.map((r) => (
        <div className="card" key={r.id} data-testid="report-card">
          <div className="row between">
            <strong>
              📝 {r.serverId} · {r.teamId}
              {r.via === 'code' && <span className="label-advisory" style={{ marginLeft: 6 }} data-testid="short-code-badge">SHORT CODE</span>}
            </strong>
            <span className="small muted">
              made {agoText(r.createdAt, now)} · received via {relayText(r)}
            </span>
          </div>
          <p>
            <strong>{r.humanFinal.victimCount}</strong> people · urgency <strong>{r.humanFinal.urgency}/5</strong> · {r.humanFinal.hazards.join(', ') || 'no hazard tags'}
          </p>
          <p className="small">
            📍 {r.lat.toFixed(5)}, {r.lng.toFixed(5)} ({r.locationSource}){r.nearestShelter ? ` · ${kmText(r.nearestShelter.distanceM)} from ${r.nearestShelter.name}` : ''}
          </p>
          {r.notes && <p className="small">Notes: {r.notes}</p>}
          <p className="small">
            Requested:{' '}
            {RESOURCE_KEYS.filter((k) => r.humanFinal.requested[k])
              .map((k) => `${RESOURCES[k].label} ${r.humanFinal.requested[k]}`)
              .join(', ') || 'nothing'}
          </p>
          {r.aiSuggestion && (
            <div className="small" style={{ background: '#e5eefc', padding: 8, borderRadius: 8 }}>
              <span className="label-advisory">ADVISORY</span> Photo helper suggested: {r.aiSuggestion.hazards.join(', ') || 'no hazards'}
              {r.aiSuggestion.personCount ? ` · about ${r.aiSuggestion.personCount.estimate} people (confidence ${Math.round(r.aiSuggestion.personCount.confidence * 100)} %)` : ''} ·{' '}
              {r.aiSuggestion.backend.toUpperCase()}. The rescuer’s answer above is final.
            </div>
          )}
          {r.photos.length > 0 && (
            <>
              <h3>Photos ({r.photosReceived.length} of {r.photos.length} received)</h3>
              <div className="photo-grid">
                {r.photos.map((p, i) => (
                  <AuthImage key={p} id={p} alt={`Photo ${i + 1} of report ${r.serverId}`} />
                ))}
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
