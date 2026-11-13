/**
 * Victim registration (Phase 2, §3 step 1; changed in decisions.md 12.2): a USER ID, no
 * username, no password. Then name, age, family and work details. Needs internet once;
 * the profile is then stored on the phone AND on the server.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Profile, Registration, suggestUserId } from '@rusq/shared';
import { api, ApiError, friendlyError } from '../lib/api.ts';
import { kvSet, K } from '../lib/db.ts';
import { setSession, type Session } from '../lib/session.ts';
import { cleanDraft, EMPTY_PROFILE, ProfileForm, type ProfileDraft } from '../components/ProfileForm.tsx';

export function Register() {
  const [userId, setUserId] = useState(() => suggestUserId());
  const [profile, setProfile] = useState<ProfileDraft>(EMPTY_PROFILE);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = Registration.safeParse({ userId, profile: cleanDraft(profile) });
    if (!parsed.success) {
      const i = parsed.error.issues[0]!;
      const where = i.path[0] === 'userId' ? 'User ID' : i.path.slice(1).join(' ');
      return setError(`Please check “${where}”: ${i.message}`);
    }
    setBusy(true);
    try {
      const r = await api<Session & { profile: Profile }>('/auth/register', { method: 'POST', auth: false, body: JSON.stringify(parsed.data) });
      await kvSet(K.profile, r.profile);
      await kvSet(K.profileDirty, false);
      await kvSet(K.profileSavedAt, r.profile.updatedAt);
      await setSession({ token: r.token, user: r.user });
      nav('/setup', { replace: true });
    } catch (e) {
      setError(e instanceof ApiError && e.status === 0 ? 'No connection. Registering needs internet once – after that RusQ works offline.' : friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1>Register</h1>
      <p>Do this before a disaster, while you have internet. Your details are saved on this phone and sent with your SOS so rescuers know who you are and whom to call.</p>
      <form onSubmit={submit} className="card" noValidate>
        <h2>Your user ID</h2>
        <label className="field">
          User ID (you type this to sign in – no password needed) *
          <input
            value={userId}
            onChange={(e) => setUserId(e.target.value.toLowerCase())}
            autoComplete="username"
            name="userId"
            required
            autoCapitalize="none"
            spellCheck={false}
          />
        </label>
        <div className="row">
          <button type="button" className="btn secondary small" onClick={() => setUserId(suggestUserId())}>
            🎲 Make a new one for me
          </button>
        </div>
        <p className="small muted">
          Write it down or keep this phone signed in. You may change it to something easy to remember (3–32 letters or numbers).
        </p>
        <ProfileForm value={profile} onChange={setProfile} />
        {error && (
          <div className="banner bad" role="alert">
            {error}
          </div>
        )}
        <button className="btn block" type="submit" disabled={busy} data-testid="register-submit">
          {busy ? 'Registering…' : 'Register'}
        </button>
      </form>
      <p>
        Already registered? <Link to="/login">Sign in</Link>
      </p>
      <p className="small muted">Rescue teams and control-room staff get their accounts from the administrator.</p>
    </div>
  );
}
