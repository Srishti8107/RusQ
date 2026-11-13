/**
 * Missing persons – administrator (§10.6). SAMPLE DATA ONLY.
 * Reported → Candidate found → Under review → Verified by named admin → Announced.
 * The buttons offered are exactly the allowed next steps (the server enforces
 * the same state machine, so skipping is impossible even with a crafted request).
 */
import { useState } from 'react';
import {
  allowedActions,
  MISSING_STATE_LABELS,
  MISSING_STATES,
  VERIFY_CHECKLIST,
  type FoundPerson,
  type MissingCandidate,
  type MissingReport,
  type MissingState,
} from '@rusq/shared';
import { useCachedApi } from '../../lib/cache.ts';
import { useNow, useReach } from '../../lib/hooks.ts';
import { agoText } from '../../lib/location.ts';
import { AuthImage, Freshness, OfflineActionsNote, useAction } from '../../components/AdminBits.tsx';

interface Case {
  id: string;
  serverId: string;
  report: MissingReport;
  state: MissingState;
  candidates: MissingCandidate[];
  verifiedBy: { id: string; name: string; at: string; candidateId: string; note: string } | null;
  announcedAt: string | null;
  receivedAt: string;
  photos?: { id: string; received: boolean }[];
}

export function AdminMissing() {
  const q = useCachedApi<Case[]>('/admin/missing', 30_000);
  const reg = useCachedApi<{ people: FoundPerson[] }>('/admin/found-registry');
  const now = useNow(30_000);
  return (
    <div>
      <h1>
        Missing persons <span className="label-sample">SAMPLE DATA</span>
      </h1>
      <div className="banner info">
        Candidates are suggestions from a <strong>sample</strong> registry. A match must be verified by a named administrator (checklist + note) before the family sees anything,
        and only verified cases can be announced.
      </div>
      <Freshness q={q} />
      <OfflineActionsNote />
      {q.data?.length === 0 && <p>No missing-person reports.</p>}
      {q.data?.map((c) => (
        <CaseCard key={c.id} c={c} reload={q.reload} now={now} />
      ))}

      <div className="card table-wrap" tabIndex={0}>
        <h2>Sample registry of people at shelters ({reg.data?.people.length ?? 0})</h2>
        <p className="small muted">Fictional records used for matching. No photos, no real people.</p>
        <table>
          <thead>
            <tr>
              <th>Id</th>
              <th>Name</th>
              <th>Age</th>
              <th>Description</th>
              <th>Shelter</th>
            </tr>
          </thead>
          <tbody>
            {reg.data?.people.map((p) => (
              <tr key={p.id}>
                <td className="mono">{p.id}</td>
                <td>{p.name}</td>
                <td>{p.approxAge ?? '?'}</td>
                <td>{p.description}</td>
                <td>{p.shelterName}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CaseCard({ c, reload, now }: { c: Case; reload: () => Promise<void>; now: number }) {
  const reach = useReach();
  const act = useAction(reload);
  const [cand, setCand] = useState(c.candidates[0]?.foundPersonId ?? '');
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState('');
  const off = reach !== 'online' || act.busy;
  const allowed = allowedActions(c.state);
  const idx = MISSING_STATES.indexOf(c.state);
  const p = c.report.person;
  const run = (action: string, extra: object = {}) => act.run(`/admin/missing/${c.id}/action`, { action, ...extra });

  return (
    <div className="card" data-testid="missing-case" data-state={c.state}>
      <div className="row between">
        <strong>
          🔎 {p.name} <span className="mono">{c.serverId}</span>
        </strong>
        <span className="small muted">reported {agoText(c.receivedAt, now)}</span>
      </div>
      <div className="state-steps" aria-label={`State: ${MISSING_STATE_LABELS[c.state]}`}>
        {MISSING_STATES.map((s, i) => (
          <span key={s} className={i < idx ? 'done' : i === idx ? 'now' : ''}>
            {i + 1}. {MISSING_STATE_LABELS[s]}
          </span>
        ))}
      </div>
      <p className="small">
        {p.age !== undefined ? `Age ${p.age}. ` : ''}Gender: {p.gender}. {p.description && <>“{p.description}”. </>}Last seen: {c.report.lastSeen.place}. Family contact:{' '}
        <a href={`tel:${c.report.contactPhone}`}>{c.report.contactPhone}</a>
        {c.report.relation ? ` (${c.report.relation})` : ''}.
      </p>
      {!!c.photos?.length && (
        <div data-testid="missing-photos">
          <p className="small" style={{ marginBottom: 4 }}>
            <strong>Photos from the family</strong> (compare them with the person at the shelter – the system does not compare faces):
          </p>
          <div className="thumbs">
            {c.photos.map((ph, i) =>
              ph.received ? (
                <AuthImage key={ph.id} id={ph.id} alt={`Photo ${i + 1} of ${p.name}`} />
              ) : (
                <span key={ph.id} className="small muted" data-testid="missing-photo-pending">
                  Photo {i + 1}: still on its way
                </span>
              ),
            )}
          </div>
        </div>
      )}

      {c.candidates.length > 0 && (
        <fieldset className="card" style={{ margin: '8px 0' }}>
          <legend>
            <strong>Candidates</strong> <span className="label-sample">SAMPLE</span> <span className="label-advisory">ADVISORY</span>
          </legend>
          {c.candidates.map((k) => (
            <label key={k.foundPersonId} className="check" style={{ alignItems: 'flex-start' }}>
              {c.state === 'under_review' && <input type="radio" name={`cand-${c.id}`} checked={cand === k.foundPersonId} onChange={() => setCand(k.foundPersonId)} />}
              <span>
                {k.name} at {k.shelterName} – confidence <strong>{Math.round(k.confidence * 100)} %</strong>
                <br />
                <span className="small muted">
                  name {pct(k.breakdown.name)} · age {pct(k.breakdown.age)} · gender {pct(k.breakdown.gender)} · description {pct(k.breakdown.description)} · place {pct(k.breakdown.location)}
                </span>
                <ul className="reason-list">
                  {k.evidence.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </span>
            </label>
          ))}
        </fieldset>
      )}

      {c.verifiedBy && (
        <div className="banner ok">
          Verified by <strong>{c.verifiedBy.name}</strong> {agoText(c.verifiedBy.at, now)}: “{c.verifiedBy.note}”{c.announcedAt ? ` · announced ${agoText(c.announcedAt, now)}` : ''}
        </div>
      )}

      {c.state === 'reported' && (
        <button className="btn secondary small" disabled={off} onClick={() => void act.run(`/admin/missing/${c.id}/match`, {})}>
          Search the sample registry again
        </button>
      )}
      {allowed.includes('start_review') && (
        <button className="btn small" disabled={off} onClick={() => void run('start_review')} data-testid="start-review">
          Start review
        </button>
      )}
      {c.state === 'under_review' && (
        <div className="stack" style={{ gap: 6 }}>
          <strong>Verification (all three are required)</strong>
          {VERIFY_CHECKLIST.map((k) => (
            <label className="check" key={k.id}>
              <input type="checkbox" checked={!!checks[k.id]} onChange={(e) => setChecks((s) => ({ ...s, [k.id]: e.target.checked }))} />
              <span>{k.label}</span>
            </label>
          ))}
          <label className="field">
            Verification note (who confirmed, how) *
            <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} style={{ minHeight: 70 }} />
          </label>
          <div className="row">
            <button className="btn small" disabled={off || !cand} onClick={() => void run('verify', { candidateId: cand, checks, note })} data-testid="verify">
              ✔ Verify selected candidate (as you)
            </button>
            <button className="btn danger secondary small" disabled={off} onClick={() => void run('reject_candidates', { note })}>
              ✖ None of these is the person
            </button>
          </div>
        </div>
      )}
      {allowed.includes('announce') && (
        <button className="btn small" disabled={off} onClick={() => void run('announce')} data-testid="announce">
          📢 Announce officially
        </button>
      )}
      {act.error && (
        <div className="banner bad" role="alert">
          {act.error}
        </div>
      )}
    </div>
  );
}

const pct = (x: number) => `${Math.round(x * 100)} %`;
