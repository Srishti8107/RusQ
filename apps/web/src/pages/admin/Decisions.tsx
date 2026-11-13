/**
 * Decision support (§10.4): rule-based recommendations, each with its
 * reasoning and evidence. ADVISORY – nothing happens until an administrator
 * approves or rejects; every decision is final and audit-logged.
 */
import { useState } from 'react';
import { REC_KIND_LABELS, type RecKind, type Recommendation } from '@rusq/shared';
import { useCachedApi } from '../../lib/cache.ts';
import { useNow, useReach } from '../../lib/hooks.ts';
import { agoText } from '../../lib/location.ts';
import { Freshness, OfflineActionsNote, SevBadge, useAction } from '../../components/AdminBits.tsx';

interface Data {
  output: { rulesVersion: string; generatedFor: string; recommendations: Recommendation[] };
  decided: Record<string, { decision: string; actorName: string; note: string | null; decidedAt: string }>;
  history: { recId: string; kind: string; decision: string; actorName: string; note: string | null; decidedAt: string; rec: Recommendation }[];
  cctvEnabled: boolean;
}

const KINDS = Object.keys(REC_KIND_LABELS) as RecKind[];

export function AdminDecisions() {
  const q = useCachedApi<Data>('/admin/decisions', 30_000);
  const [kind, setKind] = useState<RecKind | 'all'>('all');
  const now = useNow(30_000);
  const recs = (q.data?.output.recommendations ?? []).filter((r) => kind === 'all' || r.kind === kind);
  const pending = recs.filter((r) => !q.data?.decided[r.id]);
  const done = recs.filter((r) => q.data?.decided[r.id]);

  return (
    <div>
      <h1>Recommendations</h1>
      <div className="banner info">
        <span className="label-advisory">ADVISORY</span> These come from fixed rules (shown under each one). The system assists – <strong>you decide</strong>. Nothing is sent to
        teams until you approve it.
      </div>
      <Freshness q={q} />
      <OfflineActionsNote />
      {q.data && (
        <p className="small muted">
          Rules {q.data.output.rulesVersion}. Inputs: SOS, field reports, shelters, live stock, team skills
          {q.data.cctvEnabled ? <>, and <span className="label-sample">SAMPLE</span> CCTV detections</> : ' (sample CCTV is switched off)'}.
        </p>
      )}
      <div className="tabs" role="group" aria-label="Recommendation type">
        <button aria-pressed={kind === 'all'} onClick={() => setKind('all')}>
          All ({q.data?.output.recommendations.length ?? 0})
        </button>
        {KINDS.map((k) => (
          <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>
            {REC_KIND_LABELS[k]} ({q.data?.output.recommendations.filter((r) => r.kind === k).length ?? 0})
          </button>
        ))}
      </div>

      <h2>Waiting for your decision ({pending.length})</h2>
      {pending.length === 0 && <p>Nothing waiting.</p>}
      {pending.map((r) => (
        <RecCard key={r.id} r={r} reload={q.reload} />
      ))}

      {done.length > 0 && <h2>Already decided ({done.length})</h2>}
      {done.map((r) => {
        const d = q.data!.decided[r.id]!;
        return (
          <div className="card" key={r.id} data-testid="rec-decided">
            <div className="row between">
              <strong>{r.title}</strong>
              <span className={`status ${d.decision === 'approve' ? 'received' : 'queued'}`}>{d.decision === 'approve' ? '✔ Approved' : '✖ Rejected'}</span>
            </div>
            <p className="small muted">
              by {d.actorName} {agoText(d.decidedAt, now)}
              {d.note ? ` – “${d.note}”` : ''}
            </p>
          </div>
        );
      })}

      {q.data && q.data.history.length > 0 && (
        <div className="card table-wrap" tabIndex={0}>
          <h2>Decision log</h2>
          <p className="small muted">Includes decisions on recommendations that no longer apply (the situation changed).</p>
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Decision</th>
                <th>Recommendation</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {q.data.history.map((h) => (
                <tr key={h.recId}>
                  <td>{new Date(h.decidedAt).toLocaleString()}</td>
                  <td>{h.decision === 'approve' ? 'Approved' : 'Rejected'}</td>
                  <td>{h.rec.title}</td>
                  <td>{h.actorName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RecCard({ r, reload }: { r: Recommendation; reload: () => Promise<void> }) {
  const reach = useReach();
  const act = useAction(reload);
  const [note, setNote] = useState('');
  const off = reach !== 'online' || act.busy;
  const decide = (decision: 'approve' | 'reject') => act.run(`/admin/decisions/${encodeURIComponent(r.id)}`, { decision, note: note || undefined });
  const ev = [...r.evidence.sos.map((x) => `SOS ${x}`), ...r.evidence.reports.map((x) => `report ${x}`), ...r.evidence.cctv.map((x) => `${x} (sample CCTV)`)];

  return (
    <div className="card" data-testid="rec-card" data-kind={r.kind}>
      <div className="row between">
        <span className="small">
          <SevBadge s={r.severity} /> {REC_KIND_LABELS[r.kind]}
        </span>
      </div>
      <h3>{r.title}</h3>
      <p>{r.summary}</p>
      <strong className="small">Why:</strong>
      <ul className="reason-list">
        {r.reasoning.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
      {r.kind === 'resource_distribution' && <Distribution perSite={r.proposal.perSite as Record<string, Record<string, number>>} />}
      {ev.length > 0 && <p className="small muted">Based on: {ev.slice(0, 12).join(', ')}{ev.length > 12 ? ` and ${ev.length - 12} more` : ''}</p>}
      <label className="field">
        Note (optional, saved in the audit log)
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </label>
      <div className="row">
        <button className="btn" disabled={off} onClick={() => void decide('approve')} data-testid="rec-approve">
          ✔ Approve
        </button>
        <button className="btn danger secondary" disabled={off} onClick={() => void decide('reject')} data-testid="rec-reject">
          ✖ Reject
        </button>
      </div>
      {act.error && (
        <div className="banner bad" role="alert">
          {act.error}
        </div>
      )}
    </div>
  );
}

function Distribution({ perSite }: { perSite: Record<string, Record<string, number>> }) {
  const sites = Object.keys(perSite).filter((s) => Object.values(perSite[s]!).some((v) => v > 0));
  const res = [...new Set(sites.flatMap((s) => Object.keys(perSite[s]!).filter((k) => perSite[s]![k]! > 0)))];
  if (!sites.length) return null;
  return (
    <div className="table-wrap" tabIndex={0}>
      <table>
        <thead>
          <tr>
            <th>Site</th>
            {res.map((k) => (
              <th key={k}>{k.replace(/_/g, ' ')}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sites.map((s) => (
            <tr key={s}>
              <td>{s}</td>
              {res.map((k) => (
                <td key={k}>{perSite[s]![k] ?? 0}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
