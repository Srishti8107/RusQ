/**
 * Home. People needing help and rescuers see the big round SOS button FIRST, with the message
 * whether their SOS reached the control room right below it (decisions.md 12.11, 12.12).
 * Everything else follows as big, labelled buttons. No "Sent & waiting" page any more:
 * rescuers see the status of their own reports here.
 */
import { Link } from 'react-router-dom';
import type { FieldReport } from '@rusq/shared';
import { useCachedApi } from '../lib/cache.ts';
import { useNow, useOutbox, useReach, useSession } from '../lib/hooks.ts';
import { agoText } from '../lib/location.ts';
import { SosPanel } from '../components/SosPanel.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';

interface Announcement {
  id: string;
  personName: string;
  shelterName: string | null;
  verifiedBy: string | null;
  announcedAt: string;
}

interface Tasks {
  teamId: string | null;
  tasks: { id: string; title: string; summary: string; approvedBy: string; approvedAt: string; note: string | null; reasoning: string[] }[];
  sos: { serverId: string; name: string; phone: string | null; contacts: { name: string; phone: string }[]; note: string | null; lat: number | null; lng: number | null }[];
}

function Action({ to, icon, title, sub }: { to: string; icon: string; title: string; sub: string }) {
  return (
    <Link to={to} className="big-action">
      <span className="icon" aria-hidden="true">
        {icon}
      </span>
      <span className="text">
        {title}
        <small>{sub}</small>
      </span>
    </Link>
  );
}

export function Home() {
  const session = useSession();
  const reach = useReach();
  const outbox = useOutbox();
  const now = useNow(30_000);
  const role = session?.user.role;
  const field = role === 'victim' || role === 'rescuer';
  const ann = useCachedApi<Announcement[]>('/announcements', 120_000);
  const tasks = useCachedApi<Tasks>(role === 'rescuer' ? '/team/tasks' : null, 60_000);
  const myReports = outbox.filter((r) => r.kind === 'report').slice(0, 5);

  return (
    <div>
      {field && <SosPanel />}

      <h1>Hello, {session?.user.name.split(' ')[0]}</h1>
      {reach !== 'online' && (
        <div className="banner warn" role="status">
          No connection to the control room right now. Anything you send is saved on this phone and goes out automatically when there is a connection.
        </div>
      )}

      {role === 'rescuer' && tasks.data && (
        <div className="card" data-testid="team-tasks">
          <h2>Tasks for your team</h2>
          {!tasks.live && tasks.at && <p className="small muted">Saved {agoText(tasks.at, now)} – no connection right now.</p>}
          {tasks.data.tasks.length === 0 && tasks.data.sos.length === 0 && <p>No tasks from the control room yet.</p>}
          {tasks.data.sos.map((s) => (
            <div className="banner bad" key={s.serverId}>
              🆘 Help {s.name} ({s.serverId}){s.lat !== null ? ` at ${s.lat.toFixed(4)}, ${s.lng!.toFixed(4)}` : ' – no location'}.
              {s.phone && (
                <>
                  {' '}
                  Phone: <a href={`tel:${s.phone}`}>{s.phone}</a>.
                </>
              )}
              {s.contacts[0] && (
                <>
                  {' '}
                  Contact: {s.contacts[0].name} <a href={`tel:${s.contacts[0].phone}`}>{s.contacts[0].phone}</a>.
                </>
              )}
              {s.note && <> Note: {s.note}</>}
            </div>
          ))}
          {tasks.data.tasks.map((t) => (
            <div className="card" key={t.id}>
              <strong>{t.title}</strong>
              <p className="small">{t.summary}</p>
              <p className="small muted">
                Approved by {t.approvedBy} {agoText(t.approvedAt, now)}
                {t.note ? ` – “${t.note}”` : ''}
              </p>
            </div>
          ))}
        </div>
      )}

      {role === 'rescuer' && myReports.length > 0 && (
        <div className="card" data-testid="my-reports">
          <h2>Your reports</h2>
          <p className="small muted">They are sent automatically. “Received” appears only after the control room confirmed with a reference number.</p>
          {myReports.map((r) => {
            const d = r.data as FieldReport;
            return (
              <div key={r.id} className="row between" style={{ marginBottom: 8 }} data-testid="outbox-row" data-kind="report" data-id={r.id}>
                <span className="small">
                  📝 {new Date(r.createdAt).toLocaleString()} · {d.victimCount} people · urgency {d.urgency}/5
                </span>
                <StatusBadge s={r} />
              </div>
            );
          })}
        </div>
      )}

      <div className="big-actions">
        {role === 'rescuer' && <Action to="/report" icon="📝" title="New field report" sub="Victims, photos, what is needed" />}
        {role === 'admin' && <Action to="/admin" icon="📊" title="Control-room dashboard" sub="Map, SOS, reports, analytics" />}
        {role === 'admin' && <Action to="/admin/sos" icon="🚨" title="SOS monitor" sub="Who needs help first – with reasons" />}
        {role === 'admin' && <Action to="/admin/decisions" icon="🧭" title="Recommendations" sub="Approve or reject – with reasons" />}
        <Action
          to="/map"
          icon="🗺️"
          title={role === 'admin' ? 'Shelters in the district' : 'Shelters near me'}
          sub={role === 'admin' ? 'Every shelter, free places, map' : 'Nearest first – works without internet'}
        />
        {field && <Action to="/missing" icon="🔎" title="Missing family member" sub="Report someone you cannot find" />}
        {field && <Action to="/profile" icon="👤" title="My profile" sub="Your details and family contacts" />}
        {field && <Action to="/nearby" icon="📶" title="Nearby phones" sub="Connects by itself on the same Wi-Fi or hotspot" />}
        {role === 'admin' && <Action to="/admin/reconcile" icon="⚖️" title="Allotments & conflicts" sub="Approve or reject provisional allotments" />}
        {role === 'admin' && <Action to="/admin/missing" icon="🔎" title="Missing persons" sub="Review candidates, verify, announce" />}
        {field && <Action to="/setup" icon="✅" title="Ready for offline" sub="Check this phone has everything saved" />}
      </div>

      <div className="card" data-testid="announcements">
        <h2>Official announcements</h2>
        <p className="small muted">
          Only people whose identity was <strong>verified by a named official</strong> appear here. <span className="label-sample">SAMPLE DATA</span>
        </p>
        {ann.data && !ann.live && ann.at && <p className="small muted">Saved {agoText(ann.at, now)} – no connection right now.</p>}
        {!ann.data?.length && <p>No announcements.</p>}
        {ann.data?.map((a) => (
          <p key={a.id}>
            ✅ <strong>{a.personName}</strong> is safe at {a.shelterName ?? 'a relief shelter'} (verified by {a.verifiedBy}).
          </p>
        ))}
      </div>
    </div>
  );
}
