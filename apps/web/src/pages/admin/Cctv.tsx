/**
 * CCTV DEMO (§10.5) – SAMPLE DATA. The "footage" is a SYNTHETIC animation
 * drawn from a scene description (no real video, no real people, figures have
 * no faces). The boxes are HAND-LABELLED detections, not model output. The
 * per-camera summary below is exactly what feeds the decision rules.
 */
import { useEffect, useRef, useState } from 'react';
import { CCTV_LABEL_TEXT, detectionsAt, waterLevelAt, type CctvCamera, type CctvSignal } from '@rusq/shared';
import { useCachedApi } from '../../lib/cache.ts';
import { useReach } from '../../lib/hooks.ts';
import { Freshness, useAction } from '../../components/AdminBits.tsx';
import { FootageAnalyser } from '../../components/FootageAnalyser.tsx';

const BOX_COLOR = { flooded_road: '#4FA3D9', crowd: '#F2C14E', blockage: '#E06A3B' } as const;

export function AdminCctv() {
  const q = useCachedApi<{ enabled: boolean; cameras: CctvCamera[]; signals: CctvSignal[]; sample: true }>('/admin/cctv');
  const [camId, setCamId] = useState('CAM-01');
  const reach = useReach();
  const act = useAction(q.reload);
  const cam = q.data?.cameras.find((c) => c.id === camId) ?? q.data?.cameras[0];

  return (
    <div>
      <h1>
        CCTV demo <span className="label-sample">SAMPLE DATA</span>
      </h1>
      <div className="banner warn">
        <strong>Not a live camera network.</strong> The clips are synthetic animations (no real people, no faces) and the detections were labelled by hand. They exist to show how
        camera information would feed the recommendations.
      </div>
      <Freshness q={q} />
      <FootageAnalyser />
      {q.data && (
        <div className="card">
          <label className="check">
            <input
              type="checkbox"
              checked={q.data.enabled}
              disabled={reach !== 'online' || act.busy}
              onChange={(e) => void act.run('/admin/cctv', { enabled: e.target.checked }, 'PUT')}
              data-testid="cctv-enabled"
            />
            <span>Use these SAMPLE detections in the recommendations</span>
          </label>
          {act.error && <div className="banner bad">{act.error}</div>}
        </div>
      )}
      <div className="tabs" role="group" aria-label="Camera">
        {q.data?.cameras.map((c) => (
          <button key={c.id} aria-pressed={c.id === cam?.id} onClick={() => setCamId(c.id)}>
            📹 {c.id}
          </button>
        ))}
      </div>
      {cam && <Player cam={cam} />}

      {q.data && (
        <div className="card table-wrap" tabIndex={0}>
          <h2>What the rules receive (per camera)</h2>
          <table>
            <thead>
              <tr>
                <th>Camera</th>
                <th>Flooded road</th>
                <th>Crowd (people)</th>
                <th>Blockage</th>
              </tr>
            </thead>
            <tbody>
              {q.data.signals.map((s) => (
                <tr key={s.cameraId}>
                  <td>
                    {s.cameraId} – {s.name}
                  </td>
                  <td>{s.flooded ? `yes (${Math.round(s.flooded * 100)} %)` : 'no'}</td>
                  <td>{s.crowd ? `${s.crowd} (${Math.round(s.crowdConfidence * 100)} %)` : '–'}</td>
                  <td>{s.blockage ? `yes (${Math.round(s.blockage * 100)} %)` : 'no'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted">Rules: flooding or blockage counts when its confidence is ≥ 50 %; the crowd number at the end of the clip is used as the people estimate for that area.</p>
        </div>
      )}
    </div>
  );
}

function Player({ cam }: { cam: CctvCamera }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(true);
  const raf = useRef<number>(0);
  const last = useRef<number | null>(null);

  useEffect(() => {
    setT(0);
  }, [cam.id]);

  useEffect(() => {
    if (!playing) return;
    const step = (ts: number) => {
      if (last.current !== null) setT((x) => (x + (ts - last.current!) / 1000) % cam.clip.durationS);
      last.current = ts;
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf.current);
      last.current = null;
    };
  }, [playing, cam]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const W = (c.width = 640);
    const H = (c.height = 360);
    const g = c.getContext('2d')!;
    draw(g, W, H, cam, t);
  }, [cam, t]);

  const active = detectionsAt(cam, t);
  return (
    <div className="card">
      <h2>
        {cam.name} <span className="label-sample">SAMPLE</span>
      </h2>
      <canvas ref={canvas} className="cctv" role="img" aria-label={`Synthetic sample clip from ${cam.name}. Visible now: ${active.map((d) => CCTV_LABEL_TEXT[d.label]).join(', ') || 'nothing labelled'}.`} />
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn secondary small" onClick={() => setPlaying((p) => !p)}>
          {playing ? '⏸ Pause' : '▶ Play'}
        </button>
        <label className="field" style={{ flex: 1, margin: 0 }}>
          Time {t.toFixed(1)} s of {cam.clip.durationS} s
          <input type="range" min={0} max={cam.clip.durationS} step={0.1} value={t} onChange={(e) => (setPlaying(false), setT(Number(e.target.value)))} />
        </label>
      </div>
      <h3>Labelled detections at this moment</h3>
      {active.length === 0 && <p className="small">None.</p>}
      <ul>
        {active.map((d, i) => (
          <li key={i}>
            <span style={{ display: 'inline-block', width: 12, height: 12, background: BOX_COLOR[d.label], marginRight: 6 }} aria-hidden="true" />
            {CCTV_LABEL_TEXT[d.label]}
            {d.count ? ` – ${d.count} people` : ''} (label confidence {Math.round(d.confidence * 100)} %)
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Synthetic scene renderer: sky, buildings, road, rising water, faceless figure icons, a blockage. */
function draw(g: CanvasRenderingContext2D, W: number, H: number, cam: CctvCamera, t: number) {
  const sc = cam.clip.scene;
  const horizon = H * 0.42;
  g.fillStyle = '#5b6b72';
  g.fillRect(0, 0, W, horizon);
  for (let i = 0; i < 60; i++) {
    // rain streaks (deterministic positions moving with t)
    const x = (i * 97 + t * 180) % W;
    const y = (i * 53 + t * 420) % H;
    g.strokeStyle = 'rgba(220,230,235,0.35)';
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x - 3, y + 10);
    g.stroke();
  }
  for (const b of sc.buildings) {
    g.fillStyle = '#3c4645';
    g.fillRect(b.x * W, horizon - b.h * H * 0.6, b.w * W, b.h * H * 0.6 + H * 0.25);
    g.fillStyle = '#c9b46a';
    for (let wy = horizon - b.h * H * 0.6 + 10; wy < horizon + 30; wy += 22) for (let wx = b.x * W + 8; wx < (b.x + b.w) * W - 10; wx += 20) g.fillRect(wx, wy, 8, 10);
  }
  g.fillStyle = '#6f6a62';
  g.beginPath();
  g.moveTo(W * 0.35, horizon);
  g.lineTo(W * 0.65, horizon);
  g.lineTo(W, H);
  g.lineTo(0, H);
  g.closePath();
  g.fill();
  const level = waterLevelAt(sc, t);
  if (level > 0) {
    const top = H - level * (H - horizon);
    g.fillStyle = 'rgba(92,120,110,0.85)';
    g.fillRect(0, top, W, H - top);
    g.strokeStyle = 'rgba(200,220,215,0.6)';
    for (let i = 0; i < 6; i++) {
      g.beginPath();
      const y = top + 8 + i * 14;
      for (let x = 0; x <= W; x += 20) g.lineTo(x, y + Math.sin((x + t * 60) / 30) * 2);
      g.stroke();
    }
  }
  if (sc.blockage && t >= sc.blockage.from) {
    const b = sc.blockage;
    g.fillStyle = b.kind === 'tree' ? '#3f5a2a' : b.kind === 'vehicle' ? '#8a2b2b' : '#7a6650';
    g.fillRect(b.x * W, b.y * H, b.w * W, b.h * H);
    g.fillStyle = '#5a3d22';
    if (b.kind === 'tree') g.fillRect(b.x * W, (b.y + b.h * 0.4) * H, b.w * W, b.h * H * 0.2);
  }
  for (const grp of sc.people) {
    if (t < grp.from) continue;
    for (let i = 0; i < grp.n; i++) {
      const x = (grp.x + ((i % 5) - 2) * 0.022) * W;
      const y = (grp.y + Math.floor(i / 5) * 0.045) * H;
      g.fillStyle = '#e8e2d0';
      g.beginPath();
      g.arc(x, y, 5, 0, Math.PI * 2); // head: plain circle, no face
      g.fill();
      g.fillRect(x - 4, y + 5, 8, 14);
    }
  }
  for (const d of detectionsAt(cam, t)) {
    const [x, y, w, h] = d.box;
    g.strokeStyle = BOX_COLOR[d.label];
    g.lineWidth = 3;
    g.strokeRect(x * W, y * H, w * W, h * H);
    const label = `${CCTV_LABEL_TEXT[d.label]}${d.count ? ` ${d.count}` : ''} ${Math.round(d.confidence * 100)}%`;
    g.font = 'bold 15px system-ui, sans-serif';
    const tw = g.measureText(label).width + 10;
    g.fillStyle = BOX_COLOR[d.label];
    g.fillRect(x * W, Math.max(0, y * H - 22), tw, 22);
    g.fillStyle = '#111';
    g.fillText(label, x * W + 5, Math.max(16, y * H - 6));
  }
  g.fillStyle = 'rgba(0,0,0,0.6)';
  g.fillRect(0, 0, W, 26);
  g.fillStyle = '#fff';
  g.font = 'bold 14px system-ui, sans-serif';
  g.fillText(`${cam.id}  SAMPLE / SYNTHETIC  t=${t.toFixed(1)}s`, 8, 18);
}
