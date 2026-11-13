/**
 * Mesh Lab – SIMULATED multi-hop mesh (§2.2b, §8A transport 1).
 * NOT real radio. Runs the real MeshNode protocol code (real envelopes, MACs,
 * signed acks) over a virtual radio with a seeded RNG, so runs are reproducible.
 * Uses throw-away keys generated in this page – never the real team key.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  generateServerKeyPair,
  generateTeamKeyB64,
  importServerPrivateKey,
  importServerPublicKey,
  importTeamKey,
  MeshSimulator,
  mulberry32,
  randomTopology,
  seededUuid,
  splitPhoto,
  type SimNodeSpec,
} from '@rusq/shared';

const SIZE = 100;

export function MeshLab() {
  const [seed, setSeed] = useState(42);
  const [count, setCount] = useState(12);
  const [range, setRange] = useState(28);
  const [loss, setLoss] = useState(10);
  const [latency, setLatency] = useState(2);
  const [sim, setSim] = useState<MeshSimulator | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [playing, setPlaying] = useState(false);
  const [, force] = useState(0);
  const [partitioned, setPartitioned] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<string | null>(null);
  const idGen = useRef(seededUuid(mulberry32(seed)));
  const redraw = () => force((x) => x + 1);

  const reset = useCallback(async () => {
    setPlaying(false);
    const kp = await generateServerKeyPair();
    const teamKey = await importTeamKey(await generateTeamKeyB64());
    const nodes: SimNodeSpec[] = randomTopology(count, SIZE, seed).map((n) => ({ ...n, x: 5 + n.x * 0.9, y: 5 + n.y * 0.9 }));
    nodes[0]!.gateway = true;
    const s = new MeshSimulator(
      { seed, nodes, range, loss: loss / 100, latency: [1, Math.max(1, latency)], duplicateRate: 0.05, bandwidth: 6 },
      teamKey,
      await importServerPrivateKey(kp.privateJwk),
      await importServerPublicKey(kp.publicJwk),
    );
    idGen.current = seededUuid(mulberry32(seed + 7));
    setSim(s);
    setSelected([]);
    setPartitioned(false);
  }, [seed, count, range, loss, latency]);

  useEffect(() => {
    void reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // live-tune radio parameters without resetting
  useEffect(() => {
    if (!sim) return;
    Object.assign(sim.cfg, { range, loss: loss / 100, latency: [1, Math.max(1, latency)] });
    redraw();
  }, [sim, range, loss, latency]);

  useEffect(() => {
    if (!playing || !sim) return;
    let alive = true;
    const loop = async () => {
      while (alive) {
        await sim.step();
        redraw();
        await new Promise((r) => setTimeout(r, 350));
      }
    };
    void loop();
    return () => {
      alive = false;
    };
  }, [playing, sim]);

  // drawing
  useEffect(() => {
    const c = canvas.current;
    if (!c || !sim) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    c.width = w * dpr;
    c.height = w * dpr;
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    const k = w / SIZE;
    ctx.clearRect(0, 0, w, w);
    const snap = sim.snapshot();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#B06B68';
    for (const l of snap.links) {
      const a = sim.specs.get(l.a)!;
      const b = sim.specs.get(l.b)!;
      ctx.beginPath();
      ctx.moveTo(a.x * k, a.y * k);
      ctx.lineTo(b.x * k, b.y * k);
      ctx.stroke();
    }
    for (const n of snap.nodes) {
      const r = 3.2 * k;
      ctx.beginPath();
      ctx.arc(n.x * k, n.y * k, r, 0, Math.PI * 2);
      ctx.fillStyle = !n.up ? '#9aa' : n.gateway ? '#0B4A22' : n.held > 0 ? '#7F0000' : '#3D0C0C';
      ctx.fill();
      if (selected.includes(n.id)) {
        ctx.lineWidth = 4;
        ctx.strokeStyle = '#1a73e8';
        ctx.stroke();
      }
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.max(10, 2.6 * k)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(n.gateway ? 'GW' : String(n.held), n.x * k, n.y * k);
      ctx.fillStyle = '#111';
      ctx.font = `${Math.max(9, 2.2 * k)}px sans-serif`;
      ctx.fillText(n.id, n.x * k, n.y * k + r + 9);
    }
    if (partitioned) {
      ctx.setLineDash([8, 6]);
      ctx.strokeStyle = '#4b2a7a';
      ctx.beginPath();
      ctx.moveTo(w / 2, 0);
      ctx.lineTo(w / 2, w);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  });

  function pos(e: React.PointerEvent) {
    const r = canvas.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * SIZE, y: ((e.clientY - r.top) / r.height) * SIZE };
  }
  function hit(p: { x: number; y: number }) {
    let best: string | null = null;
    let d = 6;
    for (const s of sim?.specs.values() ?? []) {
      const dd = Math.hypot(s.x - p.x, s.y - p.y);
      if (dd < d) (d = dd), (best = s.id);
    }
    return best;
  }

  const sel = selected[selected.length - 1];
  const snap = sim?.snapshot();
  const serverRecs = sim ? [...sim.server.records.values()] : [];

  async function sendSos() {
    if (!sim || !sel) return;
    const id = idGen.current();
    await sim.node(sel).originate('sos', { id, userId: id, lat: 26.16, lng: 91.77, accuracy: 20, locationSource: 'live', createdAt: new Date().toISOString(), source: 'app' });
    sim.log.push(`t${sim.tick}: SOS ${id.slice(-6)} created at ${sel}`);
    redraw();
  }
  async function sendPhoto() {
    if (!sim || !sel) return;
    const bytes = new Uint8Array(120_000).map((_, i) => (i * 17 + sim.tick) % 256);
    const pid = idGen.current();
    for (const c of await splitPhoto(bytes, pid, idGen.current())) await sim.node(sel).originate('photo_chunk', { data: c.data, mime: 'image/jpeg' }, { chunkInfo: c.info });
    sim.log.push(`t${sim.tick}: photo ${pid.slice(-6)} (8 chunks) created at ${sel}`);
    redraw();
  }
  function togglePartition() {
    if (!sim) return;
    if (partitioned) sim.setPartition(null);
    else {
      const ids = [...sim.specs.values()];
      sim.setPartition([ids.filter((s) => s.x < SIZE / 2).map((s) => s.id), ids.filter((s) => s.x >= SIZE / 2).map((s) => s.id)]);
    }
    sim.log.push(`t${sim.tick}: ${partitioned ? 'healed' : 'partitioned left | right'}`);
    setPartitioned(!partitioned);
  }

  return (
    <div>
      <h1>
        Mesh Lab <span className="label-sim">SIMULATED</span>
      </h1>
      <div className="banner sim" role="note">
        SIMULATED: this is a computer model of phones passing messages, for demos and testing. It is not a real radio mesh – browsers cannot use phone radios
        directly. For a real link between two phones, use “Nearby phones”.
      </div>

      <canvas
        className="meshlab"
        ref={canvas}
        data-testid="meshlab-canvas"
        aria-label="Simulated mesh map. Red dots hold messages, green GW is a gateway with internet."
        onPointerDown={(e) => {
          const id = hit(pos(e));
          if (id) {
            drag.current = id;
            setSelected((s) => [...s.filter((x) => x !== id), id].slice(-2));
          }
        }}
        onPointerMove={(e) => {
          if (drag.current && sim) {
            const p = pos(e);
            sim.setPosition(drag.current, Math.max(0, Math.min(SIZE, p.x)), Math.max(0, Math.min(SIZE, p.y)));
            redraw();
          }
        }}
        onPointerUp={() => (drag.current = null)}
      />
      <p className="small muted">
        Tap a dot to select it (tap a second dot to select a pair). Drag dots to move phones. Number = messages it holds. GW = gateway with internet.
      </p>

      <div className="card">
        <div className="row between">
          <strong>
            Tick {snap?.tick ?? 0} · delivered to server: <span data-testid="meshlab-delivered">{snap?.serverRecords ?? 0}</span> · in flight {snap?.inFlight ?? 0} · radio sends {sim?.transmissions ?? 0}
          </strong>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={() => setPlaying((p) => !p)} data-testid="meshlab-play">
            {playing ? '⏸ Pause' : '▶ Play'}
          </button>
          <button className="btn secondary" onClick={async () => (await sim?.step(), redraw())} data-testid="meshlab-step">
            Step
          </button>
          <button className="btn secondary" onClick={() => void reset()}>
            Reset
          </button>
        </div>
      </div>

      <div className="card">
        <h3>Selected: {selected.length ? selected.join(' + ') : 'none'}</h3>
        <div className="grid2">
          <label className="field">
            Choose a phone
            <select
              data-testid="meshlab-pick"
              value={selected[selected.length - 1] ?? ''}
              onChange={(e) => e.target.value && setSelected((s) => [...s.filter((x) => x !== e.target.value), e.target.value].slice(-2))}
            >
              <option value="">– none –</option>
              {[...(sim?.specs.keys() ?? [])].map((id) => (
                <option key={id} value={id}>
                  {id}
                  {sim?.specs.get(id)?.gatewayOn ? ' (gateway)' : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="row">
          <button className="btn danger" disabled={!sel} onClick={() => void sendSos()} data-testid="meshlab-sos">
            Send SOS from {sel ?? '…'}
          </button>
          <button className="btn secondary" disabled={!sel} onClick={() => void sendPhoto()}>
            Send photo
          </button>
          <button className="btn secondary" disabled={!sel} onClick={() => (sim?.setGateway(sel!, !sim.specs.get(sel!)!.gatewayOn), redraw())}>
            Gateway on/off
          </button>
          <button className="btn secondary" disabled={!sel} onClick={() => (sim?.setUp(sel!, !sim.specs.get(sel!)!.up), redraw())}>
            Phone on/off
          </button>
          <button
            className="btn secondary"
            disabled={selected.length < 2}
            onClick={() => {
              const [a, b] = selected as [string, string];
              const linked = sim!.links().some((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
              sim!.setLink(a, b, !linked);
              redraw();
            }}
          >
            Cut / restore link
          </button>
          <button className="btn secondary" onClick={togglePartition}>
            {partitioned ? 'Heal partition' : 'Split left | right'}
          </button>
        </div>
      </div>

      <div className="card">
        <h3>Radio settings</h3>
        <div className="grid2">
          <label className="field">
            Seed (same seed = same run)
            <input inputMode="numeric" value={seed} onChange={(e) => setSeed(parseInt(e.target.value || '0', 10))} />
          </label>
          <label className="field">
            Phones (5–50)
            <input inputMode="numeric" value={count} onChange={(e) => setCount(Math.min(50, Math.max(5, parseInt(e.target.value || '5', 10))))} />
          </label>
          <label className="field">
            Radio range: {range}
            <input type="range" min={10} max={60} value={range} onChange={(e) => setRange(+e.target.value)} />
          </label>
          <label className="field">
            Packet loss: {loss} %
            <input type="range" min={0} max={60} value={loss} onChange={(e) => setLoss(+e.target.value)} />
          </label>
          <label className="field">
            Max delay: {latency} ticks
            <input type="range" min={1} max={8} value={latency} onChange={(e) => setLatency(+e.target.value)} />
          </label>
        </div>
        <p className="small muted">Seed and phone count apply after Reset. Range, loss and delay apply immediately.</p>
      </div>

      <div className="card">
        <h3>Delivered to the (simulated) server</h3>
        {serverRecs.length === 0 ? (
          <p className="small">Nothing yet.</p>
        ) : (
          <ul className="small">
            {serverRecs.map((r) => (
              <li key={r.clientId}>
                {r.kind} {r.clientId.slice(-6)} → {r.serverId} at tick {r.firstTick} (uploaded {r.receivedCount}×, stored once)
              </li>
            ))}
          </ul>
        )}
        <h3>Log</h3>
        <pre className="mono small" style={{ maxHeight: 180, overflow: 'auto' }}>
          {(sim?.log ?? []).slice(-30).join('\n')}
        </pre>
      </div>
    </div>
  );
}
