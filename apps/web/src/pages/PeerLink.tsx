/**
 * Nearby phones – EXPERIMENTAL real WebRTC link (no internet needed once connected).
 *
 * decisions.md 12.10: phones connect BY THEMSELVES (autolink.ts) as soon as they are on the same
 * Wi-Fi / hotspot while the server is reachable – no QR code. The link then keeps working
 * offline. The connection CODE stays only as a fallback for phones that never were online
 * together (web apps cannot search for nearby phones on their own).
 */
import { nearbyState, onNearbyChange, startNearby } from '../lib/nearby.ts';
import { isNativeApp } from '../lib/platform.ts';
import { useEffect, useState } from 'react';
import { acceptInvite, closePeer, completeInvite, createInvite, listPeers, onPeersChange, type Peer } from '../lib/lan.ts';
import { nearbySeen, onNearbySeen } from '../lib/autolink.ts';
import { onTransferLog, transferLog, type TransferEntry } from '../lib/transferlog.ts';
import { agoText } from '../lib/location.ts';
import { useNow } from '../lib/hooks.ts';
import { getRelayNode, onRelayChange, relayInfo, type RelayInfo } from '../lib/relay.ts';
import { friendlyError } from '../lib/api.ts';
import { useReach } from '../lib/hooks.ts';
import { syncNow } from '../lib/sync.ts';

const rtcSupported = typeof RTCPeerConnection !== 'undefined';

function NearbyCard() {
  const [st, setSt] = useState(nearbyState());
  useEffect(() => {
    const off = onNearbyChange(() => setSt(nearbyState()));
    const offPeers = onPeersChange(() => setSt(nearbyState()));
    return () => (off(), offPeers());
  }, []);
  const word = { unavailable: 'not available', off: 'off', permissions: 'needs permission', starting: 'starting…', on: 'on', error: 'error' }[st.state];
  return (
    <div className={`banner ${st.state === 'on' ? 'ok' : st.state === 'error' || st.state === 'permissions' ? 'bad' : 'info'}`} data-testid="nearby-status" data-state={st.state}>
      📡 Bluetooth / Wi-Fi Direct link: <strong>{word}</strong> · {st.links} phone{st.links === 1 ? '' : 's'} linked. No internet, hotspot or pairing needed – RusQ phones nearby (about
      50–100 m) find each other by themselves while the app is open.
      {st.detail && <div className="small">{st.detail}</div>}
      {(st.state === 'off' || st.state === 'error' || st.state === 'permissions') && (
        <div>
          <button className="btn small" onClick={() => void startNearby()}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

export function PeerLink() {
  const reach = useReach();
  const [peers, setPeers] = useState<Peer[]>(listPeers());
  const [seen, setSeen] = useState<string[]>(nearbySeen());
  const [info, setInfo] = useState<RelayInfo | null>(null);
  const [mode, setMode] = useState<'idle' | 'inviting' | 'answering'>('idle');
  const [myCode, setMyCode] = useState('');
  const [input, setInput] = useState('');
  const [pendingPeer, setPendingPeer] = useState<Peer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState<boolean | null>(null);
  const [log, setLog] = useState<TransferEntry[]>([]);
  const now = useNow(15_000);
  useEffect(() => {
    void transferLog().then(setLog);
    return onTransferLog((l) => setLog([...l]));
  }, []);

  useEffect(() => onPeersChange(() => setPeers([...listPeers()])), []);
  useEffect(() => onNearbySeen(setSeen), []);
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

  async function invite() {
    setError(null);
    try {
      const { peer, code } = await createInvite();
      setPendingPeer(peer);
      setMyCode(code);
      setMode('inviting');
    } catch (e) {
      setError(friendlyError(e));
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
      setError(friendlyError(e));
    }
  }

  const held = info?.held ?? [];
  const forOthers = held.filter((m) => m.originNodeId !== info?.nodeId && m.type !== 'ack');
  const open = peers.filter((p) => p.state === 'open');

  return (
    <div>
      <h1>
        Nearby phones <span className="label-exp">EXPERIMENTAL</span>
      </h1>
      {isNativeApp && <NearbyCard />}
      <div className="banner warn" role="note" hidden={isNativeApp}>
        EXPERIMENTAL: RusQ phones on the same Wi-Fi or phone hotspot connect to each other <strong>by themselves</strong>. Once connected, messages hop from phone
        to phone without internet until one phone reaches the control room. It may not work on every phone or network.
      </div>
      {ready === false && <div className="banner bad">This phone has no team key yet. Open “Ready for offline” while connected first.</div>}
      {!rtcSupported && (
        <div className="banner bad" role="alert" data-testid="lan-unsupported">
          This browser cannot connect directly to other phones. Your messages are still saved on this phone and will be sent when there is a connection.
          Try Chrome on Android, or Safari on a recent iPhone.
        </div>
      )}

      <div className="card" data-testid="auto-link">
        <h2>Automatic connection</h2>
        <p>
          <strong data-testid="lan-open-count">{open.length}</strong> phone{open.length === 1 ? '' : 's'} connected
          {reach === 'online' ? (
            <>
              {' '}
              · <span data-testid="lan-seen-count">{seen.length}</span> other RusQ phone{seen.length === 1 ? '' : 's'} seen on this network
            </>
          ) : null}
          .
        </p>
        <p className="small muted">
          {reach === 'online'
            ? 'Keep RusQ open on the phones you want to link, on the same Wi-Fi or hotspot. They connect within a few seconds, and stay connected when the internet goes away.'
            : 'No internet now: phones that were already connected keep passing messages. New phones can connect automatically only while the server is reachable – otherwise use the code below.'}
        </p>
        {peers.length === 0 && <p>No phone connected yet.</p>}
        {peers.map((p) => (
          <div key={p.id} className="row between" data-testid="lan-peer" data-state={p.state} data-how={p.how}>
            <span>
              {p.state === 'open' ? '🟢' : p.state === 'connecting' ? '🟡' : '⚪'} <strong data-testid="lan-peer-user">{p.remoteUser ?? 'phone'}</strong>{p.remoteName ? ` (${p.remoteName})` : ''} – {p.state === 'open' ? 'connected' : p.state}
              {p.how === 'nearby' ? ' (Bluetooth / Wi-Fi Direct)' : p.how === 'auto' ? ' (automatic)' : ' (by code)'} · sent {p.sent} · got {p.received}
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

      <div className="card" data-testid="transfer-log">
        <h2>Transfer log – what went phone to phone</h2>
        <p className="small muted">
          Proof that data travelled without internet: every hand-over, the other phone&apos;s user ID and the hop number (hop 1 = straight from the phone that made it,
          hop 2 = it already passed through one other phone, and so on).
        </p>
        {log.length === 0 && <p>Nothing has been passed between phones yet.</p>}
        <ul className="small">
          {log.slice(0, 20).map((e, i) => (
            <li key={`${e.at}-${i}`} data-testid="transfer-entry" data-dir={e.dir} data-hops={e.hops ?? ''}>
              {e.dir === 'out' ? '📶 Sent to' : e.dir === 'in' ? '📥 Received from' : '✅ Confirmation via'} <strong>{e.peer}</strong>: {e.text}
              {e.hops ? ` · hop ${e.hops}` : ''} · {agoText(e.at, now)}
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h2>Did not connect by itself? Use a code</h2>
        <p className="small muted">Only needed for phones that were never online on the same network together.</p>
        {mode === 'idle' && (
          <button className="btn secondary" onClick={() => void invite()} data-testid="lan-invite" disabled={!rtcSupported}>
            1. I start – show my code
          </button>
        )}
        {myCode && (
          <div className="stack" style={{ marginTop: 10 }}>
            <p>
              <strong>{mode === 'inviting' ? 'Send this code to the other phone (for example by SMS):' : 'Now send this reply code back to the first phone:'}</strong>
            </p>
            <textarea readOnly value={myCode} className="mono" data-testid="lan-my-code" onFocus={(e) => e.currentTarget.select()} />
            <button className="btn secondary small" onClick={() => void navigator.clipboard?.writeText(myCode)}>
              Copy code
            </button>
          </div>
        )}
        {(mode === 'idle' || mode === 'inviting') && (
          <div className="stack" style={{ marginTop: 12 }}>
            <label className="field">
              {mode === 'inviting' ? '2. Paste the reply code from the other phone' : 'Or paste the code from the other phone'}
              <textarea value={input} onChange={(e) => setInput(e.target.value)} className="mono" data-testid="lan-input" />
            </label>
            <button className="btn" onClick={() => void submitCode()} disabled={!input.trim() || !rtcSupported} data-testid="lan-submit">
              Connect
            </button>
          </div>
        )}
        {mode === 'answering' && (
          <button className="btn secondary small" onClick={() => (setMode('idle'), setMyCode(''))}>
            Done
          </button>
        )}
        {error && (
          <div className="banner bad" role="alert">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
