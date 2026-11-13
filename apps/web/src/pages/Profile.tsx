/** My profile: edit offline; honest upload status ("Saved on this phone only" until the server confirms). */
import { useEffect, useState } from 'react';
import { Profile as ProfileSchema } from '@rusq/shared';
import { useLive, useNow, useReach, useSession } from '../lib/hooks.ts';
import { kvGet, K } from '../lib/db.ts';
import { agoText } from '../lib/location.ts';
import { getLocalProfile, pullProfile, saveLocalProfile, uploadProfileIfDirty } from '../lib/profile.ts';
import { StorageFullError } from '../lib/db.ts';
import { cleanDraft, EMPTY_PROFILE, ProfileForm, type ProfileDraft } from '../components/ProfileForm.tsx';
import { friendlyError } from '../lib/api.ts';

export function ProfilePage() {
  const session = useSession();
  const reach = useReach();
  const now = useNow(30_000);
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);
  const dirty = useLive(async () => (await kvGet<boolean>(K.profileDirty)) === true, [], false);
  const savedAt = useLive(async () => (await kvGet<string>(K.profileSavedAt)) ?? null, [], null);

  useEffect(() => {
    void (async () => {
      if (reach === 'online') await pullProfile();
      const p = await getLocalProfile();
      setDraft(p ? { name: p.name, contacts: p.contacts, details: p.details } : { ...EMPTY_PROFILE, name: session?.user.name ?? '' });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setMsg(null);
    const parsed = ProfileSchema.omit({ updatedAt: true }).safeParse(cleanDraft(draft));
    if (!parsed.success) {
      const i = parsed.error.issues[0]!;
      return setMsg({ kind: 'bad', text: `Please check “${i.path.join(' ')}”: ${i.message}` });
    }
    try {
      await saveLocalProfile(parsed.data);
      const sent = await uploadProfileIfDirty();
      setMsg({ kind: 'ok', text: sent ? 'Saved on this phone and on the server.' : 'Saved on this phone. It will be sent to the server when there is a connection.' });
    } catch (e) {
      setMsg({ kind: 'bad', text: e instanceof StorageFullError ? e.message : friendlyError(e) });
    }
  }

  if (!draft) return <p>Loading…</p>;
  return (
    <div>
      <h1>My profile</h1>
      <div className="card" data-testid="profile-status">
        <p style={{ marginTop: 0 }}>
          Your user ID (type it to sign in, no password): <strong className="mono" data-testid="my-user-id">{session?.user.username}</strong>
        </p>
        {dirty ? (
          <span className="status queued">⏸ Saved on this phone only – not on the server yet</span>
        ) : savedAt ? (
          <span className="status received">✔ Saved on the server ({agoText(savedAt, now)})</span>
        ) : (
          <span className="status queued">Not saved yet</span>
        )}
        <p className="small muted">Your SOS always carries the copy saved on this phone, so rescuers get your contacts even without the server copy.</p>
      </div>
      <form className="card" onSubmit={save} noValidate>
        <ProfileForm value={draft} onChange={setDraft} />
        {msg && (
          <div className={`banner ${msg.kind === 'ok' ? 'ok' : 'bad'}`} role={msg.kind === 'ok' ? 'status' : 'alert'}>
            {msg.text}
          </div>
        )}
        <button className="btn block" type="submit" data-testid="profile-save">
          Save my profile
        </button>
      </form>
    </div>
  );
}
