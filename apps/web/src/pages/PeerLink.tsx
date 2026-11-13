/**
 * Nearby phones – EXPERIMENTAL real WebRTC link (no internet needed).
 * Phone A makes an invitation code → Phone B pastes/scans it and gets a reply
 * code → Phone A pastes/scans the reply. Then both phones swap queued messages.
 */
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { acceptInvite, closePeer, completeInvite, createInvite, listPeers, onPeersChange, type Peer } from '../lib/lan.ts';
import { getRelayNode, onRelayChange, relayInfo, type RelayInfo } from '../lib/relay.ts';
import { useReach } from '../lib/hooks.ts';
import { syncNow } from '../lib/sync.ts';

const rtcSupported = typeof RTCPeerConnection !== 'undefined';

export function PeerLink() {
  const reach = useReach();
  const [peers, setPeers] = useState<Peer[]>(listPeers());
  const [info, setInfo] = useState<RelayInfo | null>(null);
  const [mode, setMode] = useState<'idle' | 'inviting' | 'answering'>('idle');
  const [myCode, setMyCode] = useState('');
  const [qr, setQr] = useState('');
  const [input, setInput] = useState('');
  const [pendingPeer, setPendingPeer] = useState<Peer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [ready, setReady] = useState<boolean | null>(null);

  useEffect(() => onPeersChange(() => setPeers([...listPeers()])), []);
  useEffect(() => {
    const refresh = () => void relayInfo().then(setInfo);
    refresh();
    void getRelayNode().then((n) => setReady(!!n));
    const off = onRelayChange(refresh);
    const t = setInterval(refresh, 3000);
    return () => {
      off();
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    if (!myCode) return setQr('');
    QRCode.toDataURL(myCode, { errorCorrectionLevel: 'L', margin: 1, width: 320 }).then(setQr, () => setQr(''));
  }, [myCode]);

  async function invite() {
    setError(null);
    try {
      const { peer, code } = await createInvite();
      setPendingPeer(peer);
      setMyCode(code);
      setMode('inviting');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function submitCode(code = input) {
    setError(null);
    try {
      if (mode === 'inviting' && pendingPeer) {
        await completeInvite(pendingPeer, code);
        setMode('idle');
        setMyCode('');
        setInput('');
      } else {
        const { reply } = await acceptInvite(code);
        setMyCode(reply);
        setMode('answering');
        setInput('');
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const held = info?.held ?? [];
  const forOthers = held.filter((m) => m.originNodeId !== info?.nodeId && m.type !== 'ack');

  return (
    <div>
      <h1>
        Nearby phones <span className="label-exp">EXPERIMENTAL</span>
      </h1>
      <div className="banner warn" role="note">
        EXPERIMENTAL: connects two phones on the same Wi-Fi or phone hotspot – no internet needed. Messages hop from phone to phone until one phone reaches the
        internet. It may not work on every phone or network.
      </div>
      {ready === false && <div className="banner bad">This phone has no team key yet. Open “Ready for offline” while connected first.</div>}
      {!rtcSupported && (
        <div className="banner bad" role="alert" data-testid="lan-unsupported">
          This browser cannot connect directly to other phones. Your messages are still saved on this phone and will be sent when there is a connection.
          Try Chrome on Android, or Safari on a recent iPhone.
        </div>
      )}

      <div className="card">
        <h2>Connect</h2>
        {mode === 'idle' && (
          <div className="stack">
            <button className="btn" onClick={() => void invite()} data-testid="lan-invite" disabled={!rtcSupported}>
              1. I start – show my code
            </button>
            <p className="small muted">Or, if the other phone started, paste or scan its code below.</p>
          </div>
        )}
        {myCode && (
          <div className="stack">
            <p>
              <strong>{mode === 'inviting' ? 'Show this code to the other phone:' : 'Now show this reply code to the first phone:'}</strong>
            </p>
            {qr && <img src={qr} alt="Connection code as QR" style={{ width: 240, height: 240, alignSelf: 'center', border: '2px solid var(--line)' }} />}
            <textarea readOnly value={myCode} className="mono" data-testid="lan-my-code" onFocus={(e) => e.currentTarget.select()} />
            <button className="btn secondary small" onClick={() => void navigator.clipboard?.writeText(myCode)}>
              Copy code
            </button>
          </div>
        )}
        {(mode === 'idle' || mode === 'inviting') && (
          <div className="stack" style={{ marginTop: 12 }}>
            <label className="field">
              {mode === 'inviting' ? '2. Paste the reply code from the other phone' : 'Paste the code from the other phone'}
              <textarea value={input} onChange={(e) => setInput(e.target.value)} className="mono" data-testid="lan-input" />
            </label>
            <div className="row">
              <button className="btn" onClick={() => void submitCode()} disabled={!input.trim() || !rtcSupported} data-testid="lan-submit">
                Connect
              </button>
              <button className="btn secondary" onClick={() => setScanning(true)}>
                📷 Scan QR
              </button>
            </div>
          </div>
        )}
        {mode === 'answering' && (
          <button className="btn secondary small" onClick={() => (setMode('idle'), setMyCode(''))}>
            Done
          </button>
        )}
        {scanning && (
          <QrScanner
            onResult={(t) => {
              setScanning(false);
              setInput(t);
              void submitCode(t);
            }}
            onClose={() => setScanning(false)}
          />
        )}
        {error && (
          <div className="banner bad" role="alert">
            {error}
          </div>
        )}
      </div>

      <div className="card">
        <h2>Connected phones</h2>
        {peers.length === 0 && <p>None yet.</p>}
        {peers.map((p) => (
          <div key={p.id} className="row between" data-testid="lan-peer" data-state={p.state}>
            <span>
              {p.state === 'open' ? '🟢' : p.state === 'connecting' ? '🟡' : '⚪'} {p.remoteNodeId ?? 'phone'} – {p.state} · sent {p.sent} · got {p.received}
            </span>
            <button className="btn small secondary" onClick={() => closePeer(p.id)}>
              Disconnect
            </button>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Messages this phone is carrying</h2>
        <p>
          <strong data-testid="lan-held">{held.filter((m) => m.type !== 'ack').length}</strong> waiting to reach the control room ·{' '}
          <strong data-testid="lan-for-others">{forOthers.length}</strong> from other phones.
        </p>
        <ul className="small">
          {held
            .filter((m) => m.type !== 'photo_chunk')
            .slice(0, 20)
            .map((m) => (
              <li key={m.id} data-testid="lan-held-item" data-type={m.type} data-id={m.id}>
                {m.type} {m.id.slice(-6)} from {m.originNodeId === info?.nodeId ? 'this phone' : m.originNodeId} · {m.hops} hop(s)
              </li>
            ))}
        </ul>
        {reach === 'online' && forOthers.length > 0 && (
          <button className="btn" onClick={() => void syncNow('gateway')}>
            Upload for the other phones now
          </button>
        )}
      </div>
    </div>
  );
}

function QrScanner({ onResult, onClose }: { onResult: (text: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    const c = document.createElement('canvas');
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        video.current!.srcObject = stream;
        await video.current!.play();
        const tick = () => {
          const v = video.current;
          if (v && v.videoWidth) {
            c.width = v.videoWidth;
            c.height = v.videoHeight;
            const ctx = c.getContext('2d')!;
            ctx.drawImage(v, 0, 0);
            const code = jsQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
            if (code?.data) return onResult(code.data);
          }
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch (e) {
        setErr(`Camera not available: ${(e as Error).message}. Paste the code instead.`);
      }
    })();
    return () => {
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onResult]);
  return (
    <div className="stack" style={{ marginTop: 10 }}>
      {err ? <div className="banner bad">{err}</div> : <video ref={video} playsInline muted style={{ width: '100%', borderRadius: 12 }} />}
      <button className="btn secondary" onClick={onClose}>
        Close camera
      </button>
    </div>
  );
}
