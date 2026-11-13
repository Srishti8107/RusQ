/**
 * App shell: header (brand, real connectivity, who is signed in), a fully
 * VISIBLE navigation grid (no hamburger), and the routes. Every page is
 * reachable with one tap from the nav.
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useReach, useSession } from './lib/hooks.ts';
import { setSession } from './lib/session.ts';
import { onUpdateReady, applyUpdate } from './lib/update.ts';
import { Home } from './pages/Home.tsx';
import { Login } from './pages/Login.tsx';
import { Setup } from './pages/Setup.tsx';
import { SosPage } from './pages/Sos.tsx';
import { ReportPage } from './pages/Report.tsx';
import { OutboxPage } from './pages/Outbox.tsx';
import { SettingsPage } from './pages/Settings.tsx';

// Heavier, less-used screens load on demand (still precached by the service worker,
// so they open offline too). Keeps the first online visit fast on slow mobile data.
const MeshLab = lazy(() => import('./pages/MeshLab.tsx').then((m) => ({ default: m.MeshLab })));
const PeerLink = lazy(() => import('./pages/PeerLink.tsx').then((m) => ({ default: m.PeerLink })));
const AdminReconcile = lazy(() => import('./pages/AdminReconcile.tsx').then((m) => ({ default: m.AdminReconcile })));
import type { Role } from '@rusq/shared';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  roles: Role[] | 'all';
  sos?: boolean;
}

const NAV: NavItem[] = [
  { to: '/sos', label: 'SOS', icon: '🆘', roles: ['victim', 'rescuer'], sos: true },
  { to: '/', label: 'Home', icon: '🏠', roles: 'all' },
  { to: '/report', label: 'New report', icon: '📝', roles: ['rescuer'] },
  { to: '/outbox', label: 'Sent & waiting', icon: '📤', roles: ['victim', 'rescuer'] },
  { to: '/nearby', label: 'Nearby phones', icon: '📶', roles: ['victim', 'rescuer'] },
  { to: '/admin/reconcile', label: 'Allotments', icon: '⚖️', roles: ['admin'] },
  { to: '/mesh-lab', label: 'Mesh Lab', icon: '🧪', roles: ['rescuer', 'admin'] },
  { to: '/setup', label: 'Ready for offline', icon: '✅', roles: 'all' },
  { to: '/settings', label: 'Settings', icon: '⚙️', roles: 'all' },
];

export function App() {
  const session = useSession();
  const reach = useReach();
  const loc = useLocation();
  const navigate = useNavigate();
  const [updateReady, setUpdateReady] = useState(false);
  useEffect(() => onUpdateReady(setUpdateReady), []);

  if (session === undefined) return <div className="main">Loading…</div>;

  const role = session?.user.role;
  const items = NAV.filter((n) => n.roles === 'all' || (role && n.roles.includes(role)));

  return (
    <>
      <header className="app-header">
        <Link to="/" className="brand" aria-label="RusQ home">
          <img src="/icons/icon-192.png" alt="" />
          RusQ
        </Link>
        <div className="header-right">
          <span className={`pill ${reach}`} role="status" aria-live="polite" data-testid="reach">
            <span className="dot" aria-hidden="true" />
            {reach === 'online' ? 'Online' : reach === 'offline' ? 'Offline' : 'Checking…'}
          </span>
          {session && (
            <span className="pill user">
              {session.user.name} · {session.user.role}
            </span>
          )}
        </div>
      </header>

      {session && (
        <nav className="nav" aria-label="Main">
          {items.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `${isActive ? 'active' : ''} ${n.sos ? 'sos-link' : ''}`}>
              <span aria-hidden="true">{n.icon}</span> {n.label}
            </NavLink>
          ))}
          <button className="btn small secondary" onClick={async () => (await setSession(null), navigate('/login', { replace: true }))}>
            Sign out
          </button>
        </nav>
      )}

      {updateReady && (
        <div className="banner info" style={{ margin: '8px 16px' }}>
          A new version of RusQ is ready.{' '}
          <button className="btn small" onClick={applyUpdate}>
            Update now
          </button>
        </div>
      )}

      <main className="main">
        <Suspense fallback={<p>Loading…</p>}>
        <Routes>
          <Route path="/login" element={session ? <Navigate to="/" replace /> : <Login />} />
          {!session ? (
            <Route path="*" element={<Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />} />
          ) : (
            <>
              <Route path="/" element={<Home />} />
              <Route path="/sos" element={<SosPage />} />
              <Route path="/report" element={<ReportPage />} />
              <Route path="/outbox" element={<OutboxPage />} />
              <Route path="/nearby" element={<PeerLink />} />
              <Route path="/mesh-lab" element={<MeshLab />} />
              <Route path="/admin/reconcile" element={role === 'admin' ? <AdminReconcile /> : <Navigate to="/" replace />} />
              <Route path="/setup" element={<Setup />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </>
          )}
        </Routes>
        </Suspense>
      </main>
    </>
  );
}
