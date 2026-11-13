/**
 * Analyse a CCTV / phone VIDEO file (decisions.md 12.7) – ADVISORY.
 *
 * No training happens here, and none is possible from one clip: the PRE-TRAINED on-device models
 * of the photo helper (CLIP for scene type, YOLOS-tiny for counting people / boats) look at
 * one frame every few seconds. The result is a time line plus a summary with the same kinds
 * of information the CCTV sample feeds the rules (flooded road, crowd size, blockage) and the
 * other hazards the photo helper knows. The video stays on this computer – nothing is uploaded –
 * and the result is NOT fed into the recommendations automatically: the operator reads it and
 * decides.
 */
import { useRef, useState } from 'react';
import type { VisionSuggestion } from '@rusq/shared';
import { analyzePhoto, loadVision } from '../lib/vision.ts';
import { getSettings } from '../lib/session.ts';
import { friendlyError } from '../lib/api.ts';

export interface FrameResult {
  t: number;
  s: VisionSuggestion;
}

/** Up to `max` evenly spread sample times (seconds), at least `minStep` apart. */
export function sampleTimes(duration: number, max = 20, minStep = 2): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return [0];
  const step = Math.max(minStep, duration / max);
  const out: number[] = [];
  for (let t = Math.min(0.5, duration / 2); t < duration && out.length < max; t += step) out.push(Math.round(t * 10) / 10);
  return out;
}

/** What the clip shows overall: per hazard the share of frames and first time, peak counts. */
export function summarise(frames: FrameResult[]) {
  const hazards = new Map<string, { frames: number; first: number; best: number }>();
  let people = 0;
  let peopleConf = 0;
  let boats = 0;
  for (const f of frames) {
    for (const h of f.s.hazards) {
      const score = f.s.labels.find((l) => l.label === h)?.score ?? 0;
      const cur = hazards.get(h) ?? { frames: 0, first: f.t, best: 0 };
      hazards.set(h, { frames: cur.frames + 1, first: Math.min(cur.first, f.t), best: Math.max(cur.best, score) });
    }
    if ((f.s.personCount?.estimate ?? 0) > people) {
      people = f.s.personCount!.estimate;
      peopleConf = f.s.personCount!.confidence;
    }
    boats = Math.max(boats, f.s.boatCount?.estimate ?? 0);
  }
  // Clip-level verdict: average every label's probability over all frames, so one odd frame
  // (glare, a red bus, a sodium street light) cannot turn a flood clip into "fire".
  const avg = new Map<string, number>();
  for (const f of frames) for (const l of f.s.labels) avg.set(l.label, (avg.get(l.label) ?? 0) + l.score / frames.length);
  const overall = [...avg.entries()].map(([label, score]) => ({ label, score })).sort((a, b) => b.score - a.score);
  return {
    overall,
    hazards: [...hazards.entries()].map(([label, v]) => ({ label, share: frames.length ? v.frames / frames.length : 0, first: v.first, best: v.best })).sort((a, b) => b.share - a.share),
    peakPeople: people,
    peakPeopleConfidence: peopleConf,
    peakBoats: boats,
  };
}

function seek(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((res, rej) => {
    const done = () => (v.removeEventListener('seeked', done), res());
    v.addEventListener('seeked', done);
    v.addEventListener('error', () => rej(new Error('This video cannot be read by the browser.')), { once: true });
    v.currentTime = t;
  });
}

function frameBlob(v: HTMLVideoElement): Promise<Blob> {
  const scale = Math.min(1, 640 / Math.max(v.videoWidth, v.videoHeight));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(v.videoWidth * scale));
  c.height = Math.max(1, Math.round(v.videoHeight * scale));
  c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('could not read a frame'))), 'image/jpeg', 0.85));
}

const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export function FootageAnalyser() {
  const [frames, setFrames] = useState<FrameResult[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mock, setMock] = useState(false);
  const [name, setName] = useState('');
  const video = useRef<HTMLVideoElement>(null);

  async function analyse(file: File) {
    setError(null);
    setFrames([]);
    setBusy(true);
    setName(file.name);
    const url = URL.createObjectURL(file);
    try {
      const { visionMock } = await getSettings();
      setMock(visionMock);
      const v = video.current!;
      v.src = url;
      await new Promise<void>((res, rej) => {
        v.onloadedmetadata = () => res();
        v.onerror = () => rej(new Error('This video format cannot be opened in this browser. Try an MP4 (H.264) or WebM file.'));
      });
      if (!visionMock) {
        setStatus('Loading the on-device models (first time: about 100 MB)…');
        await loadVision();
      }
      // Many recordings (phones, browsers) report an unknown length until the end is visited.
      if (!Number.isFinite(v.duration)) await seek(v, 1e7).catch(() => {});
      const times = sampleTimes(v.duration);
      const out: FrameResult[] = [];
      for (const [i, t] of times.entries()) {
        setStatus(`Looking at frame ${i + 1} of ${times.length} (at ${fmt(t)})…`);
        await seek(v, t);
        const s = await analyzePhoto(await frameBlob(v), { mock: visionMock });
        out.push({ t, s });
        setFrames([...out]);
      }
      setStatus(null);
    } catch (e) {
      setError(friendlyError(e));
      setStatus(null);
    } finally {
      URL.revokeObjectURL(url);
      setBusy(false);
    }
  }

  const sum = summarise(frames);

  return (
    <div className="card" data-testid="footage">
      <h2>
        Analyse a video file <span className="label-exp">ADVISORY</span>
      </h2>
      <p className="small">
        Choose a CCTV or phone video. RusQ looks at one picture every few seconds with its <strong>pre-trained</strong> on-device models and lists what it
        sees: flooded road, blocked road, fire or smoke, collapsed building, landslide, damaged bridge, people waiting, and an estimate of how many people and
        boats are visible. <strong>The video stays on this computer.</strong> The models were not trained on your footage. They can be wrong, and the result is
        not used by the recommendations unless you act on it.
      </p>
      <label className="field">
        Video file
        <input type="file" accept="video/*" disabled={busy} data-testid="footage-file" onChange={(e) => e.target.files?.[0] && void analyse(e.target.files[0])} />
      </label>
      <video ref={video} muted playsInline preload="auto" style={{ display: 'none' }} />
      {mock && <div className="banner bad">Photo helper is in MOCK mode (Settings). These results are fake – for testing only.</div>}
      {status && (
        <p role="status" aria-live="polite">
          {status}
        </p>
      )}
      {error && (
        <div className="banner bad" role="alert">
          {error}
        </div>
      )}
      {frames.length > 0 && (
        <div data-testid="footage-summary" data-frames={frames.length}>
          <h3>What the video shows (suggestion) – {name}</h3>
          {sum.overall[0] && (
            <p data-testid="footage-overall" data-label={sum.overall[0].label}>
              Overall: <strong>{sum.overall[0].label}</strong> (average {Math.round(sum.overall[0].score * 100)} % over {frames.length} frames)
              {sum.overall[1] && sum.overall[1].score > 0.15 ? `, then ${sum.overall[1].label} (${Math.round(sum.overall[1].score * 100)} %)` : ''}
            </p>
          )}
          <ul>
            {sum.hazards
              .filter((h) => h.label !== 'normal street')
              .map((h) => (
                <li key={h.label} data-testid="footage-hazard" data-label={h.label}>
                  <strong>{h.label}</strong>: in {Math.round(h.share * 100)} % of the frames, first at {fmt(h.first)} (highest confidence {Math.round(h.best * 100)} %)
                </li>
              ))}
            {sum.hazards.every((h) => h.label === 'normal street') && <li>No hazard recognised.</li>}
            <li data-testid="footage-people">
              People visible at most: <strong>about {sum.peakPeople}</strong>
              {sum.peakPeople ? ` (confidence ${Math.round(sum.peakPeopleConfidence * 100)} %)` : ''} – an estimate, crowds are usually under-counted.
            </li>
            <li>Boats visible at most: about {sum.peakBoats}</li>
          </ul>
          <div className="table-wrap" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Scene (best guess)</th>
                  <th>People</th>
                  <th>Boats</th>
                </tr>
              </thead>
              <tbody>
                {frames.map((f) => (
                  <tr key={f.t}>
                    <td>{fmt(f.t)}</td>
                    <td>{f.s.hazards.join(', ') || f.s.labels[0]?.label}</td>
                    <td>{f.s.personCount?.estimate ?? '–'}</td>
                    <td>{f.s.boatCount?.estimate ?? '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
