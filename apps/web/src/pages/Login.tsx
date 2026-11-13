/**
 * Sign in. People needing help type only their USER ID (no password – decisions.md 12.2).
 * Rescue-team and control-room accounts also type their password.
 */
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, friendlyError } from '../lib/api.ts';
import { setSession, type Session } from '../lib/session.ts';
import { pullProfile } from '../lib/profile.ts';

export function Login() {
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const [params] = useSearchParams();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const s = await api<Session>('/auth/login', { method: 'POST', auth: false, body: JSON.stringify({ username: userId.trim().toLowerCase(), password }) });
      await setSession(s);
      const next = params.get('next');
      // The control room is always online – it does not need the "Ready for offline" step.
      const home = s.user.role === 'admin' ? '/admin' : '/setup';
      nav(next && next !== '/login' && next !== '/' ? next : home, { replace: true });
      // Keep the server copy of the profile on the phone (works offline afterwards). In the background:
      // awaiting it here let the /login route redirect to "/" before nav() ran (race seen on WebKit).
      void pullProfile();
    } catch (e) {
      setError(e instanceof ApiError && e.status === 0 ? 'No connection. Signing in needs internet once – after that RusQ works offline.' : friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1>Sign in to RusQ</h1>
      <p>Sign in once while you have internet. After that, the app keeps working without a connection.</p>
      <form onSubmit={submit} className="card">
        <label className="field">
          Your user ID
          <input autoComplete="username" value={userId} onChange={(e) => setUserId(e.target.value)} required name="userId" autoCapitalize="none" spellCheck={false} />
        </label>
        <label className="field">
          Password – only for rescue teams and the control room
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} name="password" />
        </label>
        <p className="small muted" style={{ marginTop: 0 }}>
          People who registered for help: type your user ID and leave the password empty.
        </p>
        {error && (
          <div className="banner bad" role="alert">
            {error}
          </div>
        )}
        <button className="btn block" disabled={busy} type="submit">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <div className="card">
        <p style={{ margin: 0 }}>
          New here? <Link to="/register">Register as a person who may need help</Link>
        </p>
      </div>
      <div className="card small">
        <strong>Control room:</strong> user ID <code>admin</code>, password <code>demo1234</code> (sample setup – change it for real use). Rescue-team accounts
        are created by the control room under <em>People &amp; teams</em>.
      </div>
    </div>
  );
}
