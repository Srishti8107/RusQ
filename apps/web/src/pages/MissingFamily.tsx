/**
 * Families report a missing person (§3 step 9, §10.6). Saved on the phone
 * first and synced like an SOS (honest status). The family's view of the case
 * comes from the server's REDACTED endpoint: nothing about possible matches is
 * shown until a named administrator has verified one.
 *
 * decisions.md 13.1: up to 3 PHOTOS of the missing person can be attached. They are downscaled
 * and stripped of location data on the phone, saved first, then sent after the report (also
 * through nearby phones). Only the control room and this family can see them.
 */
import { useEffect, useState } from 'react';
import { MissingReport, uuidv7 } from '@rusq/shared';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { useCachedApi } from '../lib/cache.ts';
import { db, StorageFullError } from '../lib/db.ts';
import { useNow, useOutbox, usePhotos, useSession } from '../lib/hooks.ts';
import { PhotoError, processPhoto, type ProcessedPhoto } from '../lib/photos.ts';
import { agoText, getLocation } from '../lib/location.ts';
import { queueMissing, queuePhoto } from '../lib/outbox.ts';
import { friendlyError } from '../lib/api.ts';

interface FamilyCase {
  id: string;
  serverId: string;
  personName: string;
  status: 'reported' | 'verified' | 'announced';
  message: string;
  found?: { shelterName: string; verifiedBy: string; verifiedAt: string };
}

export const MAX_MISSING_PHOTOS = 3;

type Pick = ProcessedPhoto & { id: string; url: string };

/** Thumbnails of the photos saved on THIS phone for one report. */
function OwnPhotos({ reportId }: { reportId: string }) {
  const rows = usePhotos(reportId);
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    const u = rows.map((r) => URL.createObjectURL(new Blob([r.thumbBytes], { type: 'image/jpeg' })));
    setUrls(u);
    return () => u.forEach((x) => URL.revokeObjectURL(x));
  }, [rows]);
  if (!rows.length) return null;
  return (
    <div className="thumbs" data-testid="missing-own-photos">
      {urls.map((u, i) => (
        <img key={u} src={u} alt={`Photo ${i + 1} you attached`} />
      ))}
      <span className="small muted">
        {rows.filter((r) => r.status === 'received').length} of {rows.length} photo(s) received by the control room
      </span>
    </div>
  );
}

export function MissingFamilyPage() {
  const session = useSession();
  const now = useNow(30_000);
  const outbox = useOutbox().filter((r) => r.kind === 'missing');
  const cases = useCachedApi<FamilyCase[]>('/me/missing', 60_000);
  const [form, setForm] = useState({ name: '', age: '', gender: 'unknown', description: '', place: '', useLoc: false, phone: '', relation: '' });
  const [msg, setMsg] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [photos, setPhotos] = useState<Pick[]>([]);
  const set = (p: Partial<typeof form>) => setForm((f) => ({ ...f, ...p }));

  async function addPhotos(files: FileList | null) {
    setMsg(null);
    for (const file of Array.from(files ?? []).slice(0, MAX_MISSING_PHOTOS - photos.length)) {
      try {
        const p = await processPhoto(file); // downscaled, location data removed
        setPhotos((ps) => (ps.length >= MAX_MISSING_PHOTOS ? ps : [...ps, { ...p, id: uuidv7(), url: URL.createObjectURL(p.thumb) }]));
      } catch (e) {
        setMsg({ kind: 'bad', text: e instanceof PhotoError ? e.message : `Could not add the photo: ${friendlyError(e)}` });
      }
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      const loc = form.useLoc ? await getLocation(8000) : null;
      const parsed = MissingReport.safeParse({
        id: uuidv7(),
        reporterId: session!.user.id,
        person: { name: form.name, age: form.age ? parseInt(form.age, 10) : undefined, gender: form.gender, description: form.description },
        lastSeen: { place: form.place, ...(loc?.fix ? { lat: loc.fix.lat, lng: loc.fix.lng } : {}) },
        contactPhone: form.phone,
        relation: form.relation,
        photos: photos.map((p) => p.id),
        createdAt: new Date().toISOString(),
      });
      if (!parsed.success) {
        const i = parsed.error.issues[0]!;
        setMsg({ kind: 'bad', text: `Please check “${i.path.join(' ')}”: ${i.message}` });
        return;
      }
      // photos first: the sync round started by queueMissing() then sends the report, then its photos
      for (const p of photos) {
        await queuePhoto({ id: p.id, reportId: parsed.data.id, createdAt: parsed.data.createdAt, mime: 'image/jpeg', bytes: await p.blob.arrayBuffer(), thumbBytes: await p.thumb.arrayBuffer(), width: p.width, height: p.height, location: null });
      }
      await queueMissing(parsed.data);
      try {
        const { originatePhoto } = await import('../lib/relay.ts'); // photos can also travel through nearby phones
        for (const p of photos) {
          const r = await db.photos.get(p.id);
          if (r) await originatePhoto(r);
        }
      } catch {
        /* relay not provisioned – direct sending still works */
      }
      photos.forEach((p) => URL.revokeObjectURL(p.url));
      setPhotos([]);
      setForm({ name: '', age: '', gender: 'unknown', description: '', place: '', useLoc: false, phone: '', relation: '' });
      setMsg({ kind: 'ok', text: 'Saved on this phone. It is sent to the control room automatically – see the status below.' });
    } catch (e) {
      setMsg({ kind: 'bad', text: e instanceof StorageFullError ? e.message : friendlyError(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1>Missing family member</h1>
      <div className="banner info">
        The control room compares reports with people registered at shelters. A possible match is checked by a named official first.{' '}
        <strong>You will only see a result here after it has been verified.</strong>
      </div>

      <h2>Your reports</h2>
      {cases.data && !cases.live && cases.at && <p className="small muted">Status saved {agoText(cases.at, now)} – no connection right now.</p>}
      {outbox.length === 0 && <p>You have not reported anyone.</p>}
      {outbox.map((r) => {
        const m = r.data as MissingReport;
        const c = cases.data?.find((x) => x.id === m.id);
        return (
          <div className="card" key={r.id} data-testid="missing-row">
            <div className="row between">
              <strong>{m.person.name}</strong>
              <span className="small muted">{new Date(r.createdAt).toLocaleString()}</span>
            </div>
            <StatusBadge s={r} long />
            <OwnPhotos reportId={m.id} />
            {c && (
              <div className={`banner ${c.status === 'reported' ? 'info' : 'ok'}`} data-testid="family-status" data-status={c.status}>
                {c.status === 'reported' ? '🔎 ' : '✅ '}
                {c.message}
                {c.found && (
                  <p style={{ margin: '6px 0 0' }}>
                    Found at <strong>{c.found.shelterName}</strong>. Verified by {c.found.verifiedBy} on {new Date(c.found.verifiedAt).toLocaleString()}.
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })}

      <h2>Report a missing person</h2>
      <form className="card" onSubmit={submit} noValidate>
        <label className="field">
          Their full name *
          <input value={form.name} onChange={(e) => set({ name: e.target.value })} name="missing-name" />
        </label>
        <div className="grid2">
          <label className="field">
            Age
            <input inputMode="numeric" value={form.age} onChange={(e) => set({ age: e.target.value.replace(/\D/g, '') })} name="missing-age" />
          </label>
          <label className="field">
            Gender
            <select value={form.gender} onChange={(e) => set({ gender: e.target.value })} name="missing-gender">
              <option value="unknown">Not sure / prefer not to say</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
              <option value="other">Other</option>
            </select>
          </label>
        </div>
        <label className="field">
          What do they look like? What were they wearing?
          <textarea value={form.description} onChange={(e) => set({ description: e.target.value })} name="missing-description" maxLength={1000} />
        </label>
        <fieldset className="card" style={{ margin: '10px 0' }}>
          <legend>
            <strong>Photos of them</strong> (up to {MAX_MISSING_PHOTOS}) – a clear face photo helps shelters recognise them
          </legend>
          {photos.length > 0 && (
            <div className="thumbs">
              {photos.map((p, i) => (
                <div key={p.id} className="stack" style={{ gap: 4 }}>
                  <img src={p.url} alt={`Photo ${i + 1} of the missing person`} />
                  <button type="button" className="btn danger secondary small" onClick={() => (URL.revokeObjectURL(p.url), setPhotos((ps) => ps.filter((x) => x.id !== p.id)))}>
                    Remove photo {i + 1}
                  </button>
                </div>
              ))}
            </div>
          )}
          {photos.length < MAX_MISSING_PHOTOS && (
            <label className="field">
              📷 Add a photo (camera or gallery)
              <input type="file" accept="image/*" multiple onChange={(e) => (void addPhotos(e.target.files), (e.target.value = ''))} data-testid="missing-photo-input" />
            </label>
          )}
          <p className="small muted" style={{ margin: 0 }}>
            Only the control room and you can see these photos. Location data inside the photo is removed.
          </p>
        </fieldset>
        <label className="field">
          Where were they last seen? *
          <input value={form.place} onChange={(e) => set({ place: e.target.value })} name="missing-place" />
        </label>
        <label className="check">
          <input type="checkbox" checked={form.useLoc} onChange={(e) => set({ useLoc: e.target.checked })} />
          <span>I am at that place now – add my current location</span>
        </label>
        <div className="grid2">
          <label className="field">
            Phone number to reach you *
            <input type="tel" value={form.phone} onChange={(e) => set({ phone: e.target.value })} name="missing-phone" />
          </label>
          <label className="field">
            Your relation to them
            <input value={form.relation} onChange={(e) => set({ relation: e.target.value })} name="missing-relation" />
          </label>
        </div>
        {msg && (
          <div className={`banner ${msg.kind === 'ok' ? 'ok' : 'bad'}`} role={msg.kind === 'ok' ? 'status' : 'alert'}>
            {msg.text}
          </div>
        )}
        <button className="btn block" type="submit" disabled={busy} data-testid="missing-submit">
          {busy ? 'Saving…' : 'Send report'}
        </button>
      </form>
    </div>
  );
}
