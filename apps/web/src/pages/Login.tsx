import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api.ts';
import { setSession, type Session } from '../lib/session.ts';

export function Login() {
  const [username, setUsername] = useState('');
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
      const s = await api<Session>('/auth/login', { method: 'POST', auth: false, body: JSON.stringify({ username: username.trim().toLowerCase(), password }) });
      await setSession(s);
      nav(params.get('next') && params.get('next') !== '/login' ? params.get('next')! : '/setup', { replace: true });
    } catch (e) {
      setError(e instanceof ApiError && e.status === 0 ? 'No connection. Signing in needs internet once – after that RusQ works offline.' : (e as Error).message);
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
          Username
          <input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required name="username" />
        </label>
        <label className="field">
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required name="password" />
        </label>
        {error && <div className="banner bad" role="alert">{error}</div>}
        <button className="btn block" disabled={busy} type="submit">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <div className="card small">
        <strong>Demo accounts</strong> (password <code>demo1234</code>): <code>asha</code> (person needing help), <code>ravi</code> /{' '}
        <code>meena</code> (rescue teams), <code>admin</code> (control room).
      </div>
    </div>
  );
}
