/**
 * Rescue field report (§4, §8B, §8C) – works fully offline.
 *  - location (live → last known), victim count, urgency 1–5, notes, photos
 *  - resource checklist; hazard→resource HINTS shown but never auto-ticked
 *  - on-device vision (advisory): pre-fills hazard tags / count as editable
 *    suggestions, never changes urgency; both aiSuggestion and humanFinal stored
 *  - provisional allotment from the cached snapshot with the shared engine
 */
import { ExplainShare, NotesHelper } from '../components/AssistPanels.tsx';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  computeProvisionalAllotment,
  incidentSiteId,
  HAZARD_LABELS,
  RESOURCE_KEYS,
  RESOURCES,
  resourceHints,
  uuidv7,
  type FieldReport,
  type HazardLabel,
  type ResourceKey,
  type ResourceQty,
  type Snapshot,
  type VisionSuggestion,
} from '@rusq/shared';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { alreadyAllotted, snapshotStatus } from '../lib/allotment.ts';
import { db, StorageFullError } from '../lib/db.ts';
import { useLive, useNow, useSession } from '../lib/hooks.ts';
import { agoText, getLocation, type LocationResult } from '../lib/location.ts';
import { queueAllotment, queuePhoto, queueReport } from '../lib/outbox.ts';
import { friendlyError } from '../lib/api.ts';
import { PhotoError, processPhoto, type ProcessedPhoto } from '../lib/photos.ts';
import { getDeviceId, getSettings } from '../lib/session.ts';
import { analyzePhoto } from '../lib/vision.ts';

const URGENCY_WORDS = ['', 'Low', 'Moderate', 'Serious', 'Severe', 'Critical'];

interface PhotoDraft extends ProcessedPhoto {
  id: string;
  url: string;
  vision: { state: 'idle' | 'running' | 'done' | 'failed'; result?: VisionSuggestion; error?: string };
}

export function ReportPage() {
  const session = useSession();
  const now = useNow(15_000);
  const [loc, setLoc] = useState<LocationResult | null>(null);
  const [victims, setVictims] = useState(0);
  const [victimsTouched, setVictimsTouched] = useState(false);
  const [urgency, setUrgency] = useState(3);
  const [notes, setNotes] = useState('');
  const [hazards, setHazards] = useState<Set<HazardLabel>>(new Set());
  const [suggestedHazards, setSuggestedHazards] = useState<Set<HazardLabel>>(new Set());
  const [requested, setRequested] = useState<ResourceQty>({});
  const [photos, setPhotos] = useState<PhotoDraft[]>([]);
  const [keepLocation, setKeepLocation] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [lowPower, setLowPower] = useState(false);
  const [mock, setMock] = useState(false);
  const [snap, setSnap] = useState<{ snap: Snapshot | null; ageMs: number | null; stale: boolean } | null>(null);
  const [already, setAlready] = useState<ResourceQty>({});
  const [deviceId, setDeviceId] = useState('');
  const [reportId] = useState(() => uuidv7());
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const row = useLive(() => (saved ? db.outbox.get(reportId) : Promise.resolve(undefined)), [saved, reportId], undefined);

  useEffect(() => {
    void getLocation().then(setLoc);
    void getSettings().then((s) => {
      setLowPower(s.lowPower);
      setMock(s.visionMock);
    });
    void snapshotStatus().then(async (s) => {
      setSnap(s);
      setAlready(await alreadyAllotted(s.snap?.version));
    });
    void getDeviceId().then(setDeviceId);
  }, []);

  useEffect(() => () => photos.forEach((p) => URL.revokeObjectURL(p.url)), [photos]);

  /* ----------------------------- vision ----------------------------- */

  async function runVision(id: string, blob: Blob) {
    setPhotos((ps) => ps.map((p) => (p.id === id ? { ...p, vision: { state: 'running' } } : p)));
    try {
      const result = await analyzePhoto(blob, { mock });
      setPhotos((ps) => ps.map((p) => (p.id === id ? { ...p, vision: { state: 'done', result } } : p)));
      // Pre-fill as EDITABLE suggestions. Urgency is never touched.
      setSuggestedHazards((s) => new Set([...s, ...result.hazards]));
      setHazards((h) => new Set([...h, ...result.hazards]));
      if (!victimsTouched && result.personCount && result.personCount.estimate > 0) setVictims((v) => Math.max(v, result.personCount!.estimate));
    } catch (e) {
      setPhotos((ps) => ps.map((p) => (p.id === id ? { ...p, vision: { state: 'failed', error: (e as Error).message } } : p)));
    }
  }

  async function addPhotos(files: FileList | null) {
    setPhotoError(null);
    if (!files) return;
    for (const f of Array.from(files).slice(0, 10 - photos.length)) {
      try {
        const p = await processPhoto(f);
        const draft: PhotoDraft = { ...p, id: uuidv7(), url: URL.createObjectURL(p.thumb), vision: { state: 'idle' } };
        setPhotos((ps) => [...ps, draft]);
        if (!lowPower) void runVision(draft.id, p.blob);
      } catch (e) {
        setPhotoError(e instanceof PhotoError ? e.message : `Could not add photo: ${friendlyError(e)}`);
      }
    }
  }

  const aiSuggestion = useMemo(() => mergeSuggestions(photos.map((p) => p.vision.result).filter(Boolean) as VisionSuggestion[]), [photos]);
  const hints = resourceHints([...hazards]);

  /* ------------------------ provisional allotment ------------------------ */

  const preview = useMemo(() => {
    if (!snap?.snap) return null;
    try {
      return computeProvisionalAllotment({
        snapshot: snap.snap,
        report: { id: reportId, victimCount: victims, urgency, requested },
        deviceId: deviceId || 'this-device',
        alreadyAllotted: already,
        id: '00000000-0000-7000-8000-000000000000',
        createdAt: new Date(0).toISOString(),
      });
    } catch {
      return null;
    }
  }, [snap, reportId, victims, urgency, requested, deviceId, already]);

  /* -------------------------------- save -------------------------------- */

  async function save() {
    setError(null);
    if (!loc?.fix) {
      setError('A location is needed. Tap "Get my location" or type the coordinates.');
      return;
    }
    const req = Object.fromEntries(Object.entries(requested).filter(([, v]) => (v ?? 0) > 0)) as ResourceQty;
    const report: FieldReport = {
      id: reportId,
      teamId: session?.user.teamId ?? session?.user.id ?? 'unknown',
      lat: loc.fix.lat,
      lng: loc.fix.lng,
      locationSource: loc.source,
      victimCount: victims,
      urgency,
      notes,
      photos: photos.map((p) => p.id),
      requested: req,
      aiSuggestion,
      humanFinal: { hazards: [...hazards], victimCount: victims, urgency, requested: req },
      createdAt: new Date().toISOString(),
    };
    try {
      for (const p of photos) {
        await queuePhoto({ id: p.id, reportId, createdAt: report.createdAt, mime: 'image/jpeg', bytes: await p.blob.arrayBuffer(), thumbBytes: await p.thumb.arrayBuffer(), width: p.width, height: p.height, location: keepLocation ? { lat: loc.fix.lat, lng: loc.fix.lng } : null });
      }
      await queueReport(report);
      if (snap?.snap && Object.keys(req).length > 0) {
        const { allotment } = computeProvisionalAllotment({ snapshot: snap.snap, report, deviceId, alreadyAllotted: already, id: uuidv7(), createdAt: new Date().toISOString() });
        await queueAllotment(allotment);
      }
      try {
        const { originatePhoto } = await import('../lib/relay.ts');
        for (const p of photos) {
          const r = await db.photos.get(p.id);
          if (r) await originatePhoto(r);
        }
      } catch {
        /* relay not provisioned */
      }
      setSaved(true);
    } catch (e) {
      setError(e instanceof StorageFullError ? e.message : `Could not save: ${friendlyError(e)}`);
    }
  }

  if (saved && row) {
    return (
      <div className="card" data-testid="report-saved">
        <h1>Report saved</h1>
        <StatusBadge s={row} long />
        <p>It is sent automatically as soon as there is a connection (also through nearby phones). Its status is on Home.</p>
        <div className="row">
          <Link className="btn" to="/report" reloadDocument>
            New report
          </Link>
          <Link className="btn secondary" to="/">
            Home – see my reports
          </Link>
          <Link className="btn secondary" to="/nearby">
            Nearby phones
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1>New field report</h1>

      {/* Location */}
      <section className="card">
        <h2>1. Where are you?</h2>
        {loc?.fix ? (
          <p data-testid="report-location">
            📍 {loc.fix.lat.toFixed(5)}, {loc.fix.lng.toFixed(5)}{' '}
            {loc.source === 'live' ? <>(live, ±{loc.fix.accuracy} m)</> : <strong>(Last known location, {agoText(loc.fix.at, now)})</strong>}
          </p>
        ) : (
          <p>{loc ? `No location: ${loc.error}` : 'Getting location…'}</p>
        )}
        <div className="grid2">
          <label className="field">
            Latitude
            <input inputMode="decimal" value={loc?.fix?.lat ?? ''} onChange={(e) => setLoc(manualLoc(loc, 'lat', e.target.value))} name="lat" />
          </label>
          <label className="field">
            Longitude
            <input inputMode="decimal" value={loc?.fix?.lng ?? ''} onChange={(e) => setLoc(manualLoc(loc, 'lng', e.target.value))} name="lng" />
          </label>
        </div>
        <button className="btn secondary small" onClick={() => void getLocation().then(setLoc)}>
          Get my location again
        </button>
      </section>

      {/* People + urgency */}
      <section className="card">
        <h2>2. People and urgency</h2>
        <label className="field" htmlFor="victims">
          How many people need help?
        </label>
        <div className="stepper">
          <button aria-label="Fewer people" onClick={() => (setVictimsTouched(true), setVictims((v) => Math.max(0, v - 1)))}>
            −
          </button>
          <input id="victims" name="victims" inputMode="numeric" value={victims} onChange={(e) => (setVictimsTouched(true), setVictims(clampInt(e.target.value, 0, 100000)))} />
          <button aria-label="More people" onClick={() => (setVictimsTouched(true), setVictims((v) => v + 1))}>
            +
          </button>
        </div>
        {aiSuggestion?.personCount && (
          <p className="small">
            <span className="label-advisory">PHOTO HELPER</span> estimates {aiSuggestion.personCount.estimate} people visible (confidence {Math.round(aiSuggestion.personCount.confidence * 100)} %). Please count yourself.
          </p>
        )}
        <p style={{ fontWeight: 700, marginTop: 14 }} id="urg-label">
          Urgency: {urgency} – {URGENCY_WORDS[urgency]}
        </p>
        <div className="urgency" role="group" aria-labelledby="urg-label">
          {[1, 2, 3, 4, 5].map((u) => (
            <button key={u} aria-pressed={urgency === u} onClick={() => setUrgency(u)} aria-label={`Urgency ${u} ${URGENCY_WORDS[u]}`}>
              {u}
            </button>
          ))}
        </div>
        <p className="small muted">The photo helper never changes urgency – only you do.</p>
      </section>

      {/* Photos + vision */}
      <section className="card">
        <h2>3. Photos</h2>
        <label className="btn secondary block" style={{ cursor: 'pointer' }}>
          📷 Take or add photo
          <input type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => void addPhotos(e.target.files)} data-testid="photo-input" />
        </label>
        <label className="check">
          <input type="checkbox" checked={keepLocation} onChange={(e) => setKeepLocation(e.target.checked)} />
          Attach my location to the photos (off = location removed from photos)
        </label>
        {photoError && (
          <div className="banner bad" role="alert" data-testid="photo-error">
            {photoError}
          </div>
        )}
        {mock && <div className="banner bad">Photo helper is in MOCK mode (Settings). Suggestions are fake – for testing only.</div>}
        <div className="thumbs">
          {photos.map((p) => (
            <figure key={p.id}>
              <img src={p.url} alt="Report photo thumbnail" />
              <figcaption
                data-testid="vision-state"
                data-state={p.vision.state}
                data-clip-ms={p.vision.result?.timings?.clipMs}
                data-detect-ms={p.vision.result?.timings?.detectMs}
                data-threads={p.vision.result?.timings?.threads}
                data-top={p.vision.result?.labels[0]?.label}
                data-latency-ms={p.vision.result?.latencyMs}
              >
                {p.vision.state === 'running' && 'Analysing…'}
                {p.vision.state === 'done' && `${p.vision.result!.backend.toUpperCase()} · ${p.vision.result!.latencyMs} ms`}
                {p.vision.state === 'failed' && 'Helper unavailable'}
                {p.vision.state === 'idle' && (
                  <button className="btn small secondary" onClick={() => void runVision(p.id, p.blob)}>
                    Analyse
                  </button>
                )}
              </figcaption>
            </figure>
          ))}
        </div>
        {photos.some((p) => p.vision.state === 'failed') && (
          <div className="banner warn" data-testid="vision-fallback">
            The photo helper is not available on this phone ({photos.find((p) => p.vision.state === 'failed')!.vision.error}). Please choose the hazards below yourself.
          </div>
        )}
        {aiSuggestion && (
          <div className="banner info" data-testid="vision-suggestion">
            <span className="label-advisory">SUGGESTION ONLY</span> Photo helper thinks:{' '}
            {aiSuggestion.labels.slice(0, 3).map((l) => `${l.label} ${Math.round(l.score * 100)} %`).join(' · ')}
            <div className="small">Model: {aiSuggestion.model}. Check and correct the tags below.</div>
          </div>
        )}
        {lowPower && <p className="small muted">Low-power mode is on: photos are not analysed automatically. Tap “Analyse” on a photo.</p>}
      </section>

      {/* Hazards */}
      <section className="card">
        <h2>4. What do you see?</h2>
        {HAZARD_LABELS.filter((h) => h !== 'normal street').map((h) => (
          <label className="check" key={h}>
            <input type="checkbox" checked={hazards.has(h)} onChange={(e) => setHazards((s) => toggle(s, h, e.target.checked))} />
            {cap(h)}
            {suggestedHazards.has(h) && <span className="label-advisory" style={{ marginLeft: 'auto' }}>suggested</span>}
          </label>
        ))}
      </section>

      {/* Resources */}
      <section className="card">
        <h2>5. What is needed?</h2>
        {hints.length > 0 && (
          <p className="small" data-testid="resource-hints">
            <span className="label-advisory">HINT</span> Often needed for {[...new Set(hints.map((h) => h.from))].join(', ')}: {hints.map((h) => h.note).join(', ')}. Not ticked for you.
          </p>
        )}
        {RESOURCE_KEYS.map((k) => (
          <ResourceRow key={k} k={k} value={requested[k]} hinted={hints.some((h) => h.resource === k)} onChange={(v) => setRequested((r) => ({ ...r, [k]: v }))} />
        ))}
      </section>

      <section className="card">
        <h2>6. Notes</h2>
        <label className="field">
          What did you observe?
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={4000} name="notes" />
        </label>
        <NotesHelper notes={notes} onUse={setNotes} />
      </section>

      {/* Provisional allotment */}
      <section className="card" data-testid="allotment-preview">
        <h2>
          7. Provisional share <span className="label-sim" style={{ fontSize: '0.75rem' }}>PROVISIONAL</span>
        </h2>
        {!snap?.snap && <div className="banner warn">No resource snapshot on this phone. Open “Ready for offline” while connected.</div>}
        {snap?.snap && (
          <>
            <p className="small" data-testid="snapshot-age">
              Based on snapshot v{snap.snap.version}, saved {agoText(snap.snap.createdAt, now)}.
            </p>
            {snap.stale && <div className="banner warn">This snapshot is old – stock may have changed. The control room will check.</div>}
            {Object.values(already).some(Boolean) && (
              <p className="small">
                This phone already reserved: {fmtQty(already)}.
              </p>
            )}
            {preview && Object.keys(requested).some((k) => (requested[k as ResourceKey] ?? 0) > 0) ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Resource</th>
                      <th>Asked</th>
                      <th>Can get now</th>
                      <th>Short</th>
                    </tr>
                  </thead>
                  <tbody>
                    {RESOURCE_KEYS.filter((k) => (requested[k] ?? 0) > 0).map((k) => (
                      <tr key={k}>
                        <td>{RESOURCES[k].label}</td>
                        <td>{requested[k]}</td>
                        <td data-testid={`claim-${k}`}>
                          <strong>{preview.allotment.claim[k] ?? 0}</strong>
                        </td>
                        <td>{(requested[k] ?? 0) - (preview.allotment.claim[k] ?? 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="small muted">
                  Shared fairly with {snap.snap.sites.length} shelters using the same rule as the control room (more people and higher urgency get a bigger share).
                  This is a suggestion – the control room approves the real amounts.
                </p>
                <ExplainShare result={preview.result} siteId={incidentSiteId(reportId)} requested={requested} />
              </div>
            ) : (
              <p className="small muted">Tick what is needed above to see a fair share.</p>
            )}
          </>
        )}
      </section>

      {error && (
        <div className="banner bad" role="alert">
          {error}
        </div>
      )}
      <button className="btn block" style={{ minHeight: 64, fontSize: '1.2rem' }} onClick={() => void save()} data-testid="save-report">
        💾 Save report
      </button>
    </div>
  );
}

function ResourceRow({ k, value, hinted, onChange }: { k: ResourceKey; value?: number; hinted: boolean; onChange: (v: number) => void }) {
  const checked = (value ?? 0) > 0;
  return (
    <label className="check" data-testid={`res-${k}`}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked ? Math.max(1, value ?? 1) : 0)} />
      <span>
        {RESOURCES[k].label}
        {hinted && <span className="label-advisory" style={{ marginLeft: 6, fontSize: '0.7rem' }}>hint</span>}
      </span>
      <input className="qty" aria-label={`${RESOURCES[k].label} quantity (${RESOURCES[k].unit})`} inputMode="numeric" value={value ?? ''} placeholder={RESOURCES[k].unit} onChange={(e) => onChange(clampInt(e.target.value, 0, 1_000_000))} />
    </label>
  );
}

function mergeSuggestions(list: VisionSuggestion[]): VisionSuggestion | null {
  if (list.length === 0) return null;
  if (list.length === 1) return list[0]!;
  const scores = new Map<string, number>();
  for (const s of list) for (const l of s.labels) scores.set(l.label, (scores.get(l.label) ?? 0) + l.score / list.length);
  const labels = [...scores].map(([label, score]) => ({ label, score: Math.round(score * 1000) / 1000 })).sort((a, b) => b.score - a.score);
  const people = list.map((s) => s.personCount).filter(Boolean).sort((a, b) => b!.estimate - a!.estimate)[0];
  return { ...list[0]!, labels, hazards: [...new Set(list.flatMap((s) => s.hazards))], personCount: people, latencyMs: list.reduce((m, s) => Math.max(m, s.latencyMs), 0) };
}

function manualLoc(prev: LocationResult | null, field: 'lat' | 'lng', v: string): LocationResult {
  const n = Number(v);
  const base = prev?.fix ?? { lat: 0, lng: 0, accuracy: 0, at: new Date().toISOString() };
  return { fix: { ...base, [field]: Number.isFinite(n) ? n : 0, at: new Date().toISOString() }, source: 'manual' };
}

function clampInt(v: string, min: number, max: number): number {
  const n = parseInt(v.replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : 0;
}

function toggle<T>(s: Set<T>, v: T, on: boolean): Set<T> {
  const n = new Set(s);
  if (on) n.add(v);
  else n.delete(v);
  return n;
}

function cap(s: string) {
  return s[0]!.toUpperCase() + s.slice(1);
}

function fmtQty(q: ResourceQty) {
  return Object.entries(q)
    .filter(([, v]) => v)
    .map(([k, v]) => `${RESOURCES[k as ResourceKey].label} ${v}`)
    .join(', ');
}
