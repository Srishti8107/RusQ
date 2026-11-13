/**
 * EXPERIMENTAL real peer-to-peer link (§2.2a, §8A transport 2).
 *
 * WebRTC data channel between browsers on the same Wi-Fi / hotspot with NO
 * internet: no STUN/TURN servers (host ICE candidates only), signalling by
 * copy-paste or QR code. Several peers can be connected at once; the relay
 * node forwards between them (store-and-forward).
 *
 * Wire protocol on the data channel (JSON):
 *   {t:'hello', nodeId}            on open
 *   {t:'summary', seen:[...ids], pull}  anti-entropy ("this is what I have"); pull=true asks
 *                                  the peer to answer with its own summary so we can push
 *   {t:'msg', m: MeshMessage}      a relay envelope
 */
import type { MeshMessage, MeshSummary } from '@rusq/shared';
import { getRelayNode, onRelayChange } from './relay.ts';
import { markSentViaRelay } from './outbox.ts';

export interface Peer {
  id: string;
  remoteNodeId: string | null;
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  state: 'connecting' | 'open' | 'closed';
  sent: number;
  received: number;
}

const peers = new Map<string, Peer>();
const listeners = new Set<() => void>();
export function onPeersChange(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
function notify() {
  for (const l of listeners) l();
}
export function listPeers(): Peer[] {
  return [...peers.values()];
}

const RTC_CONFIG: RTCConfiguration = { iceServers: [] }; // host candidates only – works with no internet

/* ---------------------------- signalling codec ---------------------------- */

/** Compact SDP → text for copy-paste / QR (deflate + base64url when supported). */
export async function encodeSignal(desc: RTCSessionDescriptionInit): Promise<string> {
  const json = JSON.stringify({ t: desc.type, s: hostOnly(desc.sdp ?? '') });
  if (typeof CompressionStream === 'undefined') return 'J' + btoa(unescape(encodeURIComponent(json)));
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return 'Z' + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function decodeSignal(text: string): Promise<RTCSessionDescriptionInit> {
  const t = text.trim();
  let json: string;
  if (t.startsWith('J')) json = decodeURIComponent(escape(atob(t.slice(1))));
  else if (t.startsWith('Z')) {
    const b64 = t.slice(1).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    json = await new Response(stream).text();
  } else throw new Error('Not a RusQ link code');
  const o = JSON.parse(json) as { t: RTCSdpType; s: string };
  return { type: o.t, sdp: o.s };
}

/** Drop any non-host candidates (there should be none without STUN, but be strict). */
function hostOnly(sdp: string): string {
  return sdp
    .split(/\r?\n/)
    .filter((l) => !l.startsWith('a=candidate:') || / typ host( |$)/.test(l))
    .join('\r\n');
}

function waitIce(pc: RTCPeerConnection, timeoutMs = 4000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((res) => {
    const t = setTimeout(res, timeoutMs);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(t);
        res();
      }
    });
  });
}

/* ------------------------------ connection ------------------------------ */

/** Phone A: create an invitation code. */
export async function createInvite(): Promise<{ peer: Peer; code: string }> {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const peer = addPeer(pc);
  attachChannel(peer, pc.createDataChannel('rusq-relay', { ordered: true }));
  await pc.setLocalDescription(await pc.createOffer());
  await waitIce(pc);
  return { peer, code: await encodeSignal(pc.localDescription!) };
}

/** Phone B: accept A's invitation, produce a reply code. */
export async function acceptInvite(code: string): Promise<{ peer: Peer; reply: string }> {
  const offer = await decodeSignal(code);
  if (offer.type !== 'offer') throw new Error('That is a reply code – paste it on the phone that made the invitation.');
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const peer = addPeer(pc);
  pc.ondatachannel = (e) => attachChannel(peer, e.channel);
  await pc.setRemoteDescription(offer);
  await pc.setLocalDescription(await pc.createAnswer());
  await waitIce(pc);
  return { peer, reply: await encodeSignal(pc.localDescription!) };
}

/** Phone A: finish with B's reply code. */
export async function completeInvite(peer: Peer, replyCode: string) {
  const answer = await decodeSignal(replyCode);
  if (answer.type !== 'answer') throw new Error('That is an invitation code, not a reply code.');
  await peer.pc.setRemoteDescription(answer);
}

export function closePeer(id: string) {
  const p = peers.get(id);
  if (!p) return;
  p.dc?.close();
  p.pc.close();
  p.state = 'closed';
  peers.delete(id);
  notify();
}

function addPeer(pc: RTCPeerConnection): Peer {
  const peer: Peer = { id: crypto.randomUUID(), remoteNodeId: null, pc, dc: null, state: 'connecting', sent: 0, received: 0 };
  peers.set(peer.id, peer);
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
      peer.state = 'closed';
      notify();
    }
  });
  notify();
  return peer;
}

function attachChannel(peer: Peer, dc: RTCDataChannel) {
  peer.dc = dc;
  dc.onopen = async () => {
    peer.state = 'open';
    notify();
    const n = await getRelayNode();
    send(peer, { t: 'hello', nodeId: n?.id ?? 'unprovisioned' });
    await sendSummary(peer);
  };
  dc.onclose = () => {
    peer.state = 'closed';
    notify();
  };
  dc.onmessage = (e) => void onMessage(peer, e.data as string);
}

function send(peer: Peer, obj: unknown) {
  if (peer.dc?.readyState === 'open') peer.dc.send(JSON.stringify(obj));
}

async function sendSummary(peer: Peer, pull = true) {
  const n = await getRelayNode();
  if (n) send(peer, { t: 'summary', seen: n.summary().seen, pull });
}

async function onMessage(peer: Peer, raw: string) {
  let m: { t: string; nodeId?: string; seen?: string[]; pull?: boolean; m?: MeshMessage };
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  const n = await getRelayNode();
  if (!n) return;
  if (m.t === 'hello') {
    peer.remoteNodeId = m.nodeId ?? null;
    notify();
  } else if (m.t === 'summary' && Array.isArray(m.seen)) {
    const summary: MeshSummary = { nodeId: peer.remoteNodeId ?? '?', seen: m.seen };
    const msgs = n.messagesFor(summary, 200);
    for (const msg of msgs) send(peer, { t: 'msg', m: msg });
    peer.sent += msgs.length;
    // Our own queued items are now "sent (via relay)" – never "received".
    await markSentViaRelay(msgs.filter((x) => x.originNodeId === n.id).map((x) => x.chunkInfo?.photoId ?? x.id));
    // 'pull' = the peer also wants to hear what WE lack, so it can push its new items.
    if (m.pull) await sendSummary(peer, false);
    notify();
  } else if (m.t === 'msg' && m.m) {
    const r = await n.receive(m.m);
    if (r.status === 'accepted') {
      peer.received++;
      notify();
      scheduleGossip();
    }
  }
}

/* --------------------------- relay to other peers --------------------------- */

let gossipTimer: ReturnType<typeof setTimeout> | null = null;
/** After new data arrives, re-run anti-entropy with every open peer (debounced → battery friendly). */
function scheduleGossip() {
  if (gossipTimer) return;
  gossipTimer = setTimeout(() => {
    gossipTimer = null;
    for (const p of peers.values()) if (p.state === 'open') void sendSummary(p);
  }, 800);
}

onRelayChange(() => scheduleGossip());

/** Periodic anti-entropy while peers are connected (every 10 s). */
setInterval(() => {
  for (const p of peers.values()) if (p.state === 'open') void sendSummary(p);
}, 10_000);
