/** SOS monitor (§4, §10.3): urgency level WITH its reasons, time, contacts, delivery path, and the control room's status actions. */
import { useMemo, useState } from 'react';
import { NEED_LABELS, type NeedFlag } from '@rusq/shared';
import { useCachedApi } from '../../lib/cache.ts';
import { useNow, useReach } from '../../lib/hooks.ts';
import { agoText } from '../../lib/location.ts';
import { Freshness, OfflineActionsNote, SevBadge, useAction } from '../../components/AdminBits.tsx';
import { relayText } from '../../components/AdminBits.tsx';

interface MonitorSos {
  id: string;
  serverId: string;
  userId: string;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  locationSource: string;
  locationAt?: string | null;
  createdAt: string;
  receivedAt: string;
  via: string;
  source: string;
  status: 'open' | 'acknowledged' | 'assigned' | 'resolved';
  assignedTeam: string | null;
  opsNote: string | null;
  statusAt: string | null;
  delayMs: number;
  areaSeverity: string | null;
  triage: { level: number; reasons: string[] };
  profile?: { name: string; contacts: { name: string; phone: string; relation?: string }[]; medicalNotes?: string; age?: number; phone?: string; householdSize?: number; needs?: string[] };
}

const FILTERS = ['active', 'open', 'acknowledged', 'assigned', 'resolved', 'all'] as const;

export function AdminSosMonitor() {
  const q = useCachedApi<{ sos: MonitorSos[]; teams: { teamId: string; name: string; skills: string[] }[] }>('/admin/sos-monitor', 20_000);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('active');
  const now = useNow(15_000);
  const list = useMemo(
    () =>
      (q.data?.sos ?? [])
        .filter((s) => filter === 'all' || (filter === 'active' ? s.status !== 'resolved' : s.status === filter))
        .sort((a, b) => b.triage.level - a.triage.level || a.createdAt.localeCompare(b.createdAt)),
    [q.data, filter],
  );

  return (
    <div>
      <h1>SOS monitor</h1>
      <Freshness q={q} />
      <OfflineActionsNote />
      <div className="tabs" role="group" aria-label="Filter SOS">
        {FILTERS.map((f) => (
          <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f === 'active' ? 'Not resolved' : f[0]!.toUpperCase() + f.slice(1)} ({(q.data?.sos ?? []).filter((s) => f === 'all' || (f === 'active' ? s.status !== 'resolved' : s.status === f)).length})
          </button>
        ))}
      </div>
      <p className="small muted">Sorted by urgency level (rule-based, reasons shown), then oldest first. The level is advisory – you decide.</p>
      {list.length === 0 && <p>No SOS in this list.</p>}
      {list.map((s) => (
        <SosCard key={s.id} s={s} teams={q.data!.teams} now={now} reload={q.reload} />
      ))}
    </div>
  );
}

function SosCard({ s, teams, now, reload }: { s: MonitorSos; teams: { teamId: string; name: string; skills: string[] }[]; now: number; reload: () => Promise<void> }) {
  const reach = useReach();
  const act = useAction(reload);
  const [team, setTeam] = useState(s.assignedTeam ?? teams[0]?.teamId ?? '');
  const [note, setNote] = useState(s.opsNote ?? '');
  const off = reach !== 'online' || act.busy;
  const p = s.profile;
  const set = (status: string) => act.run(`/admin/sos/${s.id}/status`, { status, teamId: status === 'assigned' ? team : null, note: note || undefined });

  return (
    <div className="card" data-testid="sos-card" data-level={s.triage.level} data-status={s.status}>
      <div className="row between">
        <div className="row">
          <span className={`level l${s.triage.level}`} aria-label={`Urgency level ${s.triage.level} of 5`}>
            {s.triage.level}
          </span>
          <div>
            <strong>{p?.name ?? 'Unknown person'}</strong> <span className="mono">{s.serverId}</span>
            <br />
            <span className="small">
              Sent {agoText(s.createdAt, now)} · status <strong>{s.status}</strong>
              {s.assignedTeam ? ` → ${s.assignedTeam}` : ''}
            </span>
          </div>
        </div>
        {s.areaSeverity && <SevBadge s={s.areaSeverity} />}
      </div>
      <ul className="reason-list">
        {s.triage.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <p className="small">
        📍{' '}
        {s.lat !== null
          ? `${s.lat.toFixed(5)}, ${s.lng!.toFixed(5)} (${s.locationSource === 'live' ? `live, ±${s.accuracy ?? '?'} m` : s.locationSource === 'last_known' ? `LAST KNOWN${s.locationAt ? `, ${agoText(s.locationAt, now)}` : ''}` : s.locationSource})`
          : 'No location'}
      </p>
      {p && (
        <div className="small">
          {p.age !== undefined && <>Age {p.age}. </>}
          {p.householdSize && <>{p.householdSize} people in the household. </>}
          {p.needs?.length ? <>Needs: {p.needs.map((n) => NEED_LABELS[n as NeedFlag] ?? n).join(', ')}. </> : null}
          {p.medicalNotes && <><strong>Medical:</strong> {p.medicalNotes}. </>}
          <div className="row" style={{ marginTop: 6 }}>
            {p.phone && (
              <a className="btn secondary small" href={`tel:${p.phone.replace(/\s/g, '')}`}>
                📞 {p.name.split(' ')[0]}: {p.phone}
              </a>
            )}
            {p.contacts.map((c) => (
              <a key={c.phone} className="btn secondary small" href={`tel:${c.phone.replace(/\s/g, '')}`}>
                📞 {c.name}
                {c.relation ? ` (${c.relation})` : ''}: {c.phone}
              </a>
            ))}
            {!p.phone && p.contacts.length === 0 && <span>No phone numbers in the profile.</span>}
          </div>
        </div>
      )}
      <p className="small muted">
        Delivery: received {new Date(s.receivedAt).toLocaleString()} via {relayText(s)} ({fmt(s.delayMs)} after it was sent) ·
        from {s.source === 'shortcut' ? 'home-screen shortcut' : s.source === 'sos_entry' ? 'SOS home-screen app' : 'the app'}
      </p>
      {s.status !== 'resolved' && (
        <div className="stack" style={{ gap: 6 }}>
          <label className="field">
            Note for the team / log
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </label>
          <div className="row">
            {s.status === 'open' && (
              <button className="btn secondary small" disabled={off} onClick={() => void set('acknowledged')}>
                Acknowledge
              </button>
            )}
            <label className="field" style={{ margin: 0, flex: '1 1 160px' }}>
              Team
              <select value={team} onChange={(e) => setTeam(e.target.value)}>
                {teams.map((t) => (
                  <option key={t.teamId} value={t.teamId}>
                    {t.name} ({t.skills.join(', ') || 'no skills recorded'})
                  </option>
                ))}
              </select>
            </label>
            <button className="btn small" disabled={off || !team} onClick={() => void set('assigned')}>
              Assign team
            </button>
            <button className="btn secondary small" disabled={off} onClick={() => void set('resolved')}>
              Mark resolved
            </button>
          </div>
        </div>
      )}
      {act.error && (
        <div className="banner bad" role="alert">
          {act.error}
        </div>
      )}
    </div>
  );
}

function fmt(ms: number) {
  const m = Math.round(ms / 60000);
  return m < 1 ? 'under a minute' : m < 120 ? `${m} min` : `${Math.round(m / 60)} h`;
}
