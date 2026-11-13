/** People & teams (admin): every account, and creating rescuer / admin accounts (victims register themselves). */
import { useState } from 'react';
import { SKILL_LABELS, SKILLS, StaffAccount, type Skill } from '@rusq/shared';
import { useCachedApi } from '../../lib/cache.ts';
import { useReach } from '../../lib/hooks.ts';
import { Freshness, useAction } from '../../components/AdminBits.tsx';

interface U {
  id: string;
  username: string;
  role: string;
  name: string;
  teamId: string | null;
  skills: string[];
  hasProfile: boolean;
  contacts: number;
  createdAt: string;
}

export function AdminPeople() {
  const q = useCachedApi<U[]>('/admin/users');
  const reach = useReach();
  const act = useAction(q.reload);
  const [f, setF] = useState({ username: '', password: '', name: '', role: 'rescuer' as 'rescuer' | 'admin', teamId: '', skills: [] as Skill[] });
  const [ok, setOk] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setOk(null);
    const parsed = StaffAccount.safeParse({ ...f, teamId: f.role === 'rescuer' ? f.teamId || null : null });
    if (!parsed.success) {
      const i = parsed.error.issues[0]!;
      act.setError(`Please check “${i.path.join(' ')}”: ${i.message}`);
      return;
    }
    if (await act.run('/admin/users', parsed.data)) {
      setOk(`Account “${f.username}” created. Give them the password in person.`);
      setF({ username: '', password: '', name: '', role: 'rescuer', teamId: '', skills: [] });
    }
  }

  const teams = [...new Set((q.data ?? []).filter((u) => u.teamId).map((u) => u.teamId!))].sort();

  return (
    <div>
      <h1>People & teams</h1>
      <Freshness q={q} />
      <div className="card table-wrap" tabIndex={0}>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>User ID</th>
              <th>Role</th>
              <th>Team / skills</th>
              <th>Profile</th>
            </tr>
          </thead>
          <tbody>
            {q.data?.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td className="mono">{u.username}</td>
                <td>{u.role}</td>
                <td>{u.teamId ? `${u.teamId}: ${u.skills.join(', ') || '–'}` : '–'}</td>
                <td>{u.role === 'victim' ? (u.hasProfile ? `yes, ${u.contacts} contact(s)` : 'not filled') : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form className="card" onSubmit={create} noValidate>
        <h2>Create a rescuer or control-room account</h2>
        <div className="grid2">
          <label className="field">
            Full name
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </label>
          <label className="field">
            Role
            <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as 'rescuer' | 'admin' })}>
              <option value="rescuer">Rescue team member</option>
              <option value="admin">Control room (admin)</option>
            </select>
          </label>
          <label className="field">
            User ID
            <input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase() })} autoComplete="off" />
          </label>
          <label className="field">
            First password (8+ characters)
            <input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" />
          </label>
        </div>
        {f.role === 'rescuer' && (
          <>
            <label className="field">
              Team id (existing: {teams.join(', ') || 'none'}) – or a new one like team-delta
              <input value={f.teamId} onChange={(e) => setF({ ...f, teamId: e.target.value.toLowerCase() })} list="team-ids" />
              <datalist id="team-ids">
                {teams.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </label>
            <fieldset className="card">
              <legend>
                <strong>Skills</strong> (used for team–skill matching)
              </legend>
              {SKILLS.map((s) => (
                <label className="check" key={s}>
                  <input type="checkbox" checked={f.skills.includes(s)} onChange={(e) => setF({ ...f, skills: e.target.checked ? [...f.skills, s] : f.skills.filter((x) => x !== s) })} />
                  <span>{SKILL_LABELS[s]}</span>
                </label>
              ))}
            </fieldset>
          </>
        )}
        {act.error && (
          <div className="banner bad" role="alert">
            {act.error}
          </div>
        )}
        {ok && <div className="banner ok">{ok}</div>}
        <button className="btn block" type="submit" disabled={reach !== 'online' || act.busy}>
          Create account
        </button>
      </form>
    </div>
  );
}
