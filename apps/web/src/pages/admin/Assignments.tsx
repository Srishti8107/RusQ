/**
 * Team assignments (control room): send a team to a specific location with a priority.
 * Pick the location from the priority areas (decision support), by tapping the map, or by
 * typing coordinates. Teams see their assignments on Home, highest priority first.
 */
import { lazy, Suspense, useMemo, useState } from 'react';
import { ASSIGNMENT_PRIORITIES, PRIORITY_LABEL, STATUS_LABEL, isActive, type Assignment, type AssignmentPriority } from '@rusq/shared';
import { useCachedApi } from '../../lib/cache.ts';
import { useNow, useReach } from '../../lib/hooks.ts';
import { agoText } from '../../lib/location.ts';
import { Freshness, OfflineActionsNote, useAction } from '../../components/AdminBits.tsx';
import type { MapMarker } from '../../components/MapView.tsx';

const MapView = lazy(() => import('../../components/MapView.tsx'));

interface BoardTeam {
  teamId: string;
  name: string;
  skills: string[];
  active: number;
  byPriority: Record<AssignmentPriority, number>;
  doneToday: number;
}
interface BoardArea {
  cellId: string;
  rank: number;
  lat: number;
  lng: number;
  priority: AssignmentPriority;
  score: number;
  people: number;
  openSos: number;
  hazards: string[];
  reasons: string[];
  place: string;
  suggestedTeam: string | null;
  assigned: { serverId: string; teamId: string; priority: AssignmentPriority }[];
}
type Row = Assignment & { teamName: string };
interface Board {
  assignments: Row[];
  teams: BoardTeam[];
  areas: BoardArea[];
}

interface Draft {
  lat: string;
  lng: string;
  place: string;
  teamId: string;
  priority: AssignmentPriority;
  instructions: string;
  cellId: string | null;
}

const EMPTY: Draft = { lat: '', lng: '', place: '', teamId: '', priority: 'high', instructions: '', cellId: null };
const FILTERS = ['active', 'done', 'cancelled', 'all'] as const;

export function PrioBadge({ p }: { p: AssignmentPriority }) {
  return <span className={`prio ${p}`}>{PRIORITY_LABEL[p].toUpperCase()}</span>;
}

export function AdminAssignments() {
  const q = useCachedApi<Board>('/admin/assignments', 20_000);
  const reach = useReach();
  const now = useNow(30_000);
  const act = useAction(q.reload);
  const [d, setD] = useState<Draft>(EMPTY);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('active');
  const [saved, setSaved] = useState<string | null>(null);
  const board = q.data;
  const teams = board?.teams ?? [];
  const off = reach !== 'online' || act.busy;

  const lat = Number(d.lat);
  const lng = Number(d.lng);
  const hasPoint = d.lat !== '' && d.lng !== '' && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  const ready = hasPoint && d.place.trim() !== '' && d.teamId !== '';

  function fromArea(a: BoardArea) {
    setSaved(null);
    setD((x) => ({ ...x, lat: String(a.lat), lng: String(a.lng), place: a.place, priority: a.priority, cellId: a.cellId, teamId: x.teamId || a.suggestedTeam || '' }));
    document.getElementById('new-assignment')?.scrollIntoView({ behavior: 'smooth' });
  }

  async function submit() {
    if (!ready) return;
    const ok = await act.run('/admin/assignments', { teamId: d.teamId, lat, lng, place: d.place.trim(), priority: d.priority, instructions: d.instructions.trim(), cellId: d.cellId });
    if (ok) {
      setSaved(`${teams.find((t) => t.teamId === d.teamId)?.name ?? d.teamId} was sent to ${d.place.trim()} (${PRIORITY_LABEL[d.priority]} priority).`);
      setD({ ...EMPTY, priority: d.priority });
    }
  }

  const markers = useMemo<MapMarker[]>(() => {
    const out: MapMarker[] = [];
    for (const a of board?.areas ?? []) {
      out.push({ id: `area-${a.cellId}`, lat: a.lat, lng: a.lng, label: `#${a.rank}`, kind: 'report', title: `Priority area #${a.rank} (${a.priority}) – ${a.people} people. Tap to assign a team here.`, onClick: () => fromArea(a) });
    }
    for (const a of (board?.assignments ?? []).filter(isActive)) {
      out.push({ id: `asg-${a.id}`, lat: a.lat, lng: a.lng, label: `${PRIORITY_LABEL[a.priority][0]} ${a.teamName.split(' ').pop()}`, kind: 'task', title: `${a.serverId}: ${a.teamName} → ${a.place} (${a.priority}, ${STATUS_LABEL[a.status]})` });
    }
    if (hasPoint) out.push({ id: 'pick', lat, lng, label: '📍 here', kind: 'pick', title: 'The new assignment goes here' });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, hasPoint, lat, lng]);

  const list = (board?.assignments ?? []).filter((a) => filter === 'all' || (filter === 'active' ? isActive(a) : a.status === filter));

  return (
    <div>
      <h1>Team assignments</h1>
      <Freshness q={q} />
      <OfflineActionsNote />

      <section className="card" id="new-assignment" data-testid="new-assignment">
        <h2>Send a team to a location</h2>
        <p className="small muted">Choose a priority area below, tap a numbered area on the map, tap anywhere on the map, or type the coordinates.</p>
        <Suspense fallback={<p>Loading map…</p>}>
          <MapView
            markers={markers}
            zoom={12}
            height="min(55vh, 420px)"
            ariaLabel="Map: priority areas (numbered), current assignments and the chosen point"
            fitMarkers
            offlineHint={false}
            onPick={(p) => {
              setSaved(null);
              setD((x) => ({ ...x, lat: String(p.lat), lng: String(p.lng), cellId: null, place: x.cellId || !x.place ? `Point ${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}` : x.place }));
            }}
          />
        </Suspense>
        <div className="grid2" style={{ marginTop: 10 }}>
          <label className="field">
            Latitude
            <input inputMode="decimal" value={d.lat} onChange={(e) => setD({ ...d, lat: e.target.value, cellId: null })} data-testid="asg-lat" />
          </label>
          <label className="field">
            Longitude
            <input inputMode="decimal" value={d.lng} onChange={(e) => setD({ ...d, lng: e.target.value, cellId: null })} data-testid="asg-lng" />
          </label>
        </div>
        <label className="field">
          Place (short name the team will see)
          <input value={d.place} maxLength={120} onChange={(e) => setD({ ...d, place: e.target.value })} data-testid="asg-place" />
        </label>
        <label className="field">
          Team
          <select value={d.teamId} onChange={(e) => setD({ ...d, teamId: e.target.value })} data-testid="asg-team">
            <option value="">Choose a team…</option>
            {teams.map((t) => (
              <option key={t.teamId} value={t.teamId}>
                {t.name} – {t.active ? `${t.active} active (${ASSIGNMENT_PRIORITIES.filter((p) => t.byPriority[p]).map((p) => `${t.byPriority[p]} ${p}`).join(', ')})` : 'free'}
                {t.skills.length ? ` – ${t.skills.join(', ')}` : ''}
              </option>
            ))}
          </select>
        </label>
        <p style={{ fontWeight: 700, margin: '10px 0 6px' }} id="prio-label">
          Priority
        </p>
        <div className="prio-pick" role="group" aria-labelledby="prio-label">
          {ASSIGNMENT_PRIORITIES.map((p) => (
            <button key={p} aria-pressed={d.priority === p} onClick={() => setD({ ...d, priority: p })} className={d.priority === p ? `prio ${p}` : ''}>
              {PRIORITY_LABEL[p]}
            </button>
          ))}
        </div>
        <label className="field">
          Instructions for the team (optional)
          <textarea value={d.instructions} maxLength={1000} onChange={(e) => setD({ ...d, instructions: e.target.value })} rows={2} data-testid="asg-instructions" />
        </label>
        {act.error && (
          <div className="banner bad" role="alert">
            {act.error}
          </div>
        )}
        {saved && (
          <div className="banner ok" role="status" data-testid="asg-saved">
            ✅ {saved}
          </div>
        )}
        <button className="btn block" disabled={!ready || off} onClick={() => void submit()} data-testid="asg-submit">
          📌 Assign
        </button>
        {!ready && <p className="small muted">Needs a location, a place name and a team.</p>}
      </section>

      <section className="card table-wrap" data-testid="asg-areas" tabIndex={0}>
        <h2>Priority areas</h2>
        <p className="small muted">From decision support (SOS, field reports, hazards). Highest first.</p>
        {board && board.areas.length === 0 && <p>No areas with people needing help right now.</p>}
        {board && board.areas.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Priority</th>
                <th>Area</th>
                <th>People</th>
                <th>Open SOS</th>
                <th>Teams sent</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {board.areas.map((a) => (
                <tr key={a.cellId} data-testid="asg-area">
                  <td>{a.rank}</td>
                  <td>
                    <PrioBadge p={a.priority} />
                  </td>
                  <td>
                    {a.place}
                    {a.hazards.length > 0 && <div className="small muted">{a.hazards.join(', ')}</div>}
                  </td>
                  <td>{a.people}</td>
                  <td>{a.openSos}</td>
                  <td>{a.assigned.length ? a.assigned.map((x) => teams.find((t) => t.teamId === x.teamId)?.name ?? x.teamId).join(', ') : <span className="muted">none</span>}</td>
                  <td>
                    <button className="btn small secondary" onClick={() => fromArea(a)}>
                      Assign a team here
                      {a.suggestedTeam && <span className="small"> (suggested: {teams.find((t) => t.teamId === a.suggestedTeam)?.name ?? a.suggestedTeam})</span>}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card table-wrap" data-testid="asg-teams" tabIndex={0}>
        <h2>Teams and their work</h2>
        <table>
          <thead>
            <tr>
              <th>Team</th>
              <th>Active</th>
              {ASSIGNMENT_PRIORITIES.map((p) => (
                <th key={p}>{PRIORITY_LABEL[p]}</th>
              ))}
              <th>Done today</th>
              <th>Skills</th>
            </tr>
          </thead>
          <tbody>
            {teams.map((t) => (
              <tr key={t.teamId} data-testid="asg-team-row" data-team={t.teamId}>
                <td>{t.name}</td>
                <td>
                  <strong>{t.active}</strong>
                </td>
                {ASSIGNMENT_PRIORITIES.map((p) => (
                  <td key={p}>{t.byPriority[p] || ''}</td>
                ))}
                <td>{t.doneToday}</td>
                <td className="small">{t.skills.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Assignments</h2>
        <div className="tabs" role="group" aria-label="Filter assignments">
          {FILTERS.map((f) => (
            <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === 'active' ? 'Active' : f[0]!.toUpperCase() + f.slice(1)} ({(board?.assignments ?? []).filter((a) => f === 'all' || (f === 'active' ? isActive(a) : a.status === f)).length})
            </button>
          ))}
        </div>
        <p className="small muted">Highest priority first, then the one waiting longest.</p>
        {list.length === 0 && <p>None.</p>}
        {list.map((a) => (
          <AssignmentCard key={a.id} a={a} teams={teams} now={now} reload={q.reload} />
        ))}
      </section>
    </div>
  );
}

function AssignmentCard({ a, teams, now, reload }: { a: Row; teams: BoardTeam[]; now: number; reload: () => Promise<void> }) {
  const reach = useReach();
  const act = useAction(reload);
  const off = reach !== 'online' || act.busy;
  const set = (body: object) => void act.run(`/admin/assignments/${a.id}`, body);
  return (
    <div className={`card assignment ${a.priority} ${a.status}`} data-testid="asg-card" data-status={a.status} data-priority={a.priority} data-team={a.teamId}>
      <div className="row between">
        <strong>
          <PrioBadge p={a.priority} /> {a.serverId} · {a.teamName} → {a.place}
        </strong>
        <span className="small">{STATUS_LABEL[a.status]}</span>
      </div>
      <p className="small">
        📍 {a.lat.toFixed(5)}, {a.lng.toFixed(5)} · assigned by {a.createdBy} {agoText(a.createdAt, now)}
        {a.updatedAt !== a.createdAt && ` · last change by ${a.updatedBy} ${agoText(a.updatedAt, now)}`}
      </p>
      {a.instructions && <p>{a.instructions}</p>}
      {a.teamNote && <p className="small">💬 Team: “{a.teamNote}”</p>}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <label className="small">
          Priority{' '}
          <select value={a.priority} disabled={off} onChange={(e) => set({ priority: e.target.value })} aria-label={`Priority of ${a.serverId}`}>
            {ASSIGNMENT_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="small">
          Team{' '}
          <select value={a.teamId} disabled={off} onChange={(e) => set({ teamId: e.target.value })} aria-label={`Team of ${a.serverId}`}>
            {teams.map((t) => (
              <option key={t.teamId} value={t.teamId}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        {isActive(a) ? (
          <>
            <button className="btn small secondary" disabled={off} onClick={() => set({ status: 'done' })}>
              Mark done
            </button>
            <button className="btn small secondary" disabled={off} onClick={() => set({ status: 'cancelled' })}>
              Cancel
            </button>
          </>
        ) : (
          <button className="btn small secondary" disabled={off} onClick={() => set({ status: 'assigned' })}>
            Reopen
          </button>
        )}
      </div>
      {act.error && (
        <div className="banner bad" role="alert">
          {act.error}
        </div>
      )}
    </div>
  );
}
