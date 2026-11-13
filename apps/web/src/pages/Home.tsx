import { Link } from 'react-router-dom';
import { isDelivered } from '@rusq/shared';
import { useOutbox, useReach, useSession } from '../lib/hooks.ts';

export function Home() {
  const session = useSession();
  const reach = useReach();
  const outbox = useOutbox();
  const waiting = outbox.filter((r) => !isDelivered(r)).length;
  const role = session?.user.role;

  return (
    <div>
      <h1>Hello, {session?.user.name.split(' ')[0]}</h1>
      {reach !== 'online' && (
        <div className="banner warn" role="status">
          No connection to the control room right now. Anything you send is saved on this phone and goes out automatically when there is a connection.
        </div>
      )}
      {waiting > 0 && (
        <div className="banner info">
          {waiting} item{waiting === 1 ? '' : 's'} not yet confirmed by the control room. <Link to="/outbox">See them</Link>
        </div>
      )}
      <div className="big-actions">
        {(role === 'victim' || role === 'rescuer') && (
          <Link to="/sos" className="big-action sos">
            <span className="icon" aria-hidden="true">🆘</span>
            <span>
              SOS – I need help
              <small>Sends your location to rescuers</small>
            </span>
          </Link>
        )}
        {role === 'rescuer' && (
          <Link to="/report" className="big-action">
            <span className="icon" aria-hidden="true">📝</span>
            <span>
              New field report
              <small>Victims, photos, what is needed</small>
            </span>
          </Link>
        )}
        {(role === 'victim' || role === 'rescuer') && (
          <Link to="/outbox" className="big-action">
            <span className="icon" aria-hidden="true">📤</span>
            <span>
              Sent & waiting
              <small>See what reached the control room</small>
            </span>
          </Link>
        )}
        {(role === 'victim' || role === 'rescuer') && (
          <Link to="/nearby" className="big-action">
            <span className="icon" aria-hidden="true">📶</span>
            <span>
              Pass messages to a nearby phone
              <small>Works on the same Wi-Fi or hotspot, no internet</small>
            </span>
          </Link>
        )}
        {role === 'admin' && (
          <Link to="/admin/reconcile" className="big-action">
            <span className="icon" aria-hidden="true">⚖️</span>
            <span>
              Allotments & conflicts
              <small>Approve or reject provisional allotments</small>
            </span>
          </Link>
        )}
        <Link to="/setup" className="big-action">
          <span className="icon" aria-hidden="true">✅</span>
          <span>
            Ready for offline
            <small>Check this phone has everything saved</small>
          </span>
        </Link>
      </div>
    </div>
  );
}
