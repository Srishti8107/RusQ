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
import { SettingsPage } from './pages/Settings.tsx';
import { Register } from './pages/Register.tsx';
import { GetApp } from './pages/GetApp.tsx';
import { fieldRoleBlockedOnWeb, useWebPolicy } from './lib/webpolicy.ts';
import { isNativeApp } from './lib/platform.ts';
import { Toasts } from './components/Toasts.tsx';
import { ProfilePage } from './pages/Profile.tsx';
import { MissingFamilyPage } from './pages/MissingFamily.tsx';

// Heavier, less-used screens load on demand (still precached by the service worker,
// so they open offline too). Keeps the first online visit fast on slow mobile data.
const AdminAssignments = lazy(() => import('./pages/admin/Assignments.tsx').then((m) => ({ default: m.AdminAssignments })));
const CodesPage = lazy(() => import('./pages/Codes.tsx').then((m) => ({ default: m.CodesPage })));
const PeerLink = lazy(() => import('./pages/PeerLink.tsx').then((m) => ({ default: m.PeerLink })));
const AdminReconcile = lazy(() => import('./pages/AdminReconcile.tsx').then((m) => ({ default: m.AdminReconcile })));
const ShelterMapPage = lazy(() => import('./pages/ShelterMap.tsx').then((m) => ({ default: m.ShelterMapPage })));
const AdminDashboard = lazy(() => import('./pages/admin/Dashboard.tsx').then((m) => ({ default: m.AdminDashboard })));
const AdminSosMonitor = lazy(() => import('./pages/admin/SosMonitor.tsx').then((m) => ({ default: m.AdminSosMonitor })));
const AdminReports = lazy(() => import('./pages/admin/Reports.tsx').then((m) => ({ default: m.AdminReports })));
const AdminDecisions = lazy(() => import('./pages/admin/Decisions.tsx').then((m) => ({ default: m.AdminDecisions })));
const AdminCctv = lazy(() => import('./pages/admin/Cctv.tsx').then((m) => ({ default: m.AdminCctv })));
const AdminMissing = lazy(() => import('./pages/admin/Missing.tsx').then((m) => ({ default: m.AdminMissing })));
const AdminPeople = lazy(() => import('./pages/admin/People.tsx').then((m) => ({ default: m.AdminPeople })));
import type { Role } from '@rusq/shared';

interface NavItem {
  to: string;
  /** a different label per role where the page differs (shelters) */
  label: string | Partial<Record<Role, string>>;
  icon: string;
  roles: Role[] | 'all';
  sos?: boolean;
}

const NAV: NavItem[] = [
  { to: '/sos', label: 'SOS', icon: '🆘', roles: ['victim', 'rescuer'], sos: true },
  { to: '/', label: 'Home', icon: '🏠', roles: 'all' },
  { to: '/admin', label: 'Dashboard', icon: '📊', roles: ['admin'] },
  { to: '/admin/sos', label: 'SOS monitor', icon: '🚨', roles: ['admin'] },
  { to: '/admin/assignments', label: 'Team assignments', icon: '📌', roles: ['admin'] },
  { to: '/admin/reports', label: 'Field reports', icon: '📋', roles: ['admin'] },
  { to: '/admin/decisions', label: 'Recommendations', icon: '🧭', roles: ['admin'] },
  { to: '/admin/reconcile', label: 'Allotments', icon: '⚖️', roles: ['admin'] },
  { to: '/admin/missing', label: 'Missing persons', icon: '🔎', roles: ['admin'] },
  { to: '/admin/cctv', label: 'CCTV', icon: '📹', roles: ['admin'] },
  { to: '/admin/people', label: 'People & teams', icon: '👥', roles: ['admin'] },
  { to: '/report', label: 'New report', icon: '📝', roles: ['rescuer'] },
  { to: '/map', label: { admin: 'Shelters in district', victim: 'Shelters near me', rescuer: 'Shelters near me' }, icon: '🗺️', roles: 'all' },
  { to: '/missing', label: 'Missing person', icon: '🔎', roles: ['victim', 'rescuer'] },
  { to: '/profile', label: 'My profile', icon: '👤', roles: ['victim', 'rescuer'] },
  { to: '/nearby', label: 'Nearby phones', icon: '📶', roles: ['victim', 'rescuer'] },
  { to: '/codes', label: 'Short codes (SMS)', icon: '📨', roles: ['rescuer', 'admin'] },
  // The control room is always online – no "Ready for offline" for admin (decisions.md 12.5).
  { to: '/setup', label: 'Ready for offline', icon: '✅', roles: ['victim', 'rescuer'] },
  { to: '/settings', label: 'Settings', icon: '⚙️', roles: 'all' },
];

/** Client-side page guard (convenience only – the server enforces every role on its API). */
function Only({ roles, role, children }: { roles: Role[]; role: Role | undefined; children: JSX.Element }) {
  return role && roles.includes(role) ? children : <Navigate to="/" replace />;
}

export function App() {
  const session = useSession();
  const reach = useReach();
  const loc = useLocation();
  const navigate = useNavigate();
  const [updateReady, setUpdateReady] = useState(false);
  useEffect(() => onUpdateReady(setUpdateReady), []);
  const policy = useWebPolicy();

  if (session === undefined) return <div className="main">Loading…</div>;

  const role = session?.user.role;
  const items = NAV.filter((n) => n.roles === 'all' || (role && n.roles.includes(role)));
  // On Home, people needing help and rescuers see the big SOS circle FIRST; the navigation
  // moves below the page there (decisions.md 12.11). Everywhere else it stays on top.
  const navBelow = (role === 'victim' || role === 'rescuer') && loc.pathname === '/';
  const nav = (
      <nav className="nav" aria-label="Main">
        {items.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/' || n.to === '/admin'} className={({ isActive }) => `${isActive ? 'active' : ''} ${n.sos ? 'sos-link' : ''}`}>
            <span aria-hidden="true" className="nav-icon">
              {n.icon}
            </span>
            <span className="nav-label">{typeof n.label === 'string' ? n.label : (role && n.label[role]) ?? ''}</span>
          </NavLink>
        ))}
        <button className="btn small secondary" onClick={async () => (await setSession(null), navigate('/login', { replace: true }))}>
          Sign out
        </button>
      </nav>
  );

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

      {session && !navBelow && !fieldRoleBlockedOnWeb(role, policy) && nav}

      {updateReady && (
        <div className="banner info" style={{ margin: '8px 16px' }}>
          A new version of RusQ is ready.{' '}
          <button className="btn small" onClick={applyUpdate}>
            Update now
          </button>
        </div>
      )}

      <Toasts />
      <main className="main">
        <Suspense fallback={<p>Loading…</p>}>
        <Routes>
          <Route path="/login" element={session ? <Navigate to="/" replace /> : <Login />} />
          <Route path="/register" element={session ? <Navigate to="/" replace /> : !isNativeApp && !(policy?.webFieldRoles ?? false) ? <GetApp policy={policy} /> : <Register />} />
          <Route path="/app" element={<GetApp policy={policy} />} />
          {session && fieldRoleBlockedOnWeb(role, policy) ? (
            // website = control room only: field roles are sent to the Android app
            <Route path="*" element={<GetApp policy={policy} signedInAs={session.user.username} onSignOut={async () => (await setSession(null), navigate('/login', { replace: true }))} />} />
          ) : !session ? (
            <Route path="*" element={<Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />} />
          ) : (
            <>
              <Route path="/" element={<Home />} />
              <Route path="/sos" element={<SosPage />} />
              <Route path="/report" element={<Only roles={['rescuer']} role={role}><ReportPage /></Only>} />
              <Route path="/map" element={<ShelterMapPage />} />
              <Route path="/profile" element={<ProfilePage />} />
              <Route path="/missing" element={<MissingFamilyPage />} />
              <Route path="/admin" element={<Only roles={['admin']} role={role}><AdminDashboard /></Only>} />
              <Route path="/admin/sos" element={<Only roles={['admin']} role={role}><AdminSosMonitor /></Only>} />
              <Route path="/admin/assignments" element={<Only roles={['admin']} role={role}><AdminAssignments /></Only>} />
              <Route path="/admin/reports" element={<Only roles={['admin']} role={role}><AdminReports /></Only>} />
              <Route path="/admin/decisions" element={<Only roles={['admin']} role={role}><AdminDecisions /></Only>} />
              <Route path="/admin/cctv" element={<Only roles={['admin']} role={role}><AdminCctv /></Only>} />
              <Route path="/admin/missing" element={<Only roles={['admin']} role={role}><AdminMissing /></Only>} />
              <Route path="/admin/people" element={<Only roles={['admin']} role={role}><AdminPeople /></Only>} />
              <Route path="/outbox" element={<Navigate to="/" replace />} />
              <Route path="/nearby" element={<PeerLink />} />
              <Route path="/codes" element={<Only roles={['rescuer', 'admin']} role={role}><CodesPage /></Only>} />
              <Route path="/admin/reconcile" element={role === 'admin' ? <AdminReconcile /> : <Navigate to="/" replace />} />
              <Route path="/setup" element={role === 'admin' ? <Navigate to="/admin" replace /> : <Setup />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </>
          )}
        </Routes>
        </Suspense>
      </main>
      {session && navBelow && !fieldRoleBlockedOnWeb(role, policy) && (
        <div className="nav-below">
          <h2 className="nav-below-title">All options</h2>
          {nav}
        </div>
      )}
    </>
  );
}
