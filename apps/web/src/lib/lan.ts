/**
 * EXPERIMENTAL real peer-to-peer link (§2.2a, §8A transport 2).
 *
 * WebRTC data channel between browsers on the same Wi-Fi / hotspot with NO
 * internet: no STUN/TURN servers (host ICE candidates only). Several peers can
 * be connected at once; the relay node forwards between them (store-and-forward).
 *
 * Signalling (exchanging the connection offers):
 *  - AUTOMATIC (autolink.ts, decisions.md 12.10): through the server while phones on the same
 *    network can reach it; the link then keeps working without internet.
 *  - fallback: copy-paste a code (QR codes were removed).
 *
 * Wire protocol on the data channel (JSON):
 *   {t:'hello', nodeId}            on open
 *   {t:'summary', seen:[...ids], pull}  anti-entropy ("this is what I have"); pull=true asks
 *                                  the peer to answer with its own summary so we can push
 *   {t:'msg', m: MeshMessage}      a relay envelope
 *
 * The same protocol also runs over the Android app's Bluetooth / Wi-Fi Direct link (nearby.ts,
 * Google Nearby Connections): such peers have no RTCPeerConnection, they send through `sendRaw`.
 */
import type { MeshMessage, MeshSummary } from '@rusq/shared';
import { getRelayNode, onRelayChange } from './relay.ts';
import { markSentViaRelay } from './outbox.ts';
import { db } from './db.ts';
import { getSession } from './session.ts';
import { toast } from './toast.ts';
import { logTransfer } from './transferlog.ts';

export interface Peer {
  id: string;
  remoteNodeId: string | null;
  /** the other phone's user ID and name (from its hello) */
  remoteUser?: string | null;
  remoteName?: string | null;
  /** set for automatic links: the node we expect at the other end */
  expectedNodeId?: string;
  /** automatic (server-introduced WebRTC), code (copy-paste WebRTC) or nearby (Android app: Bluetooth / Wi-Fi Direct) */
  how: 'auto' | 'code' | 'nearby';
  createdAt: number;
  pc: RTCPeerConnection | null;
  dc: RTCDataChannel | null;
  /** non-WebRTC transports (nearby.ts) */
  sendRaw?: (text: string) => void;
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

/** Remove a dead link (closed / failed) without touching open ones. */
export function forgetPeer(id: string) {
  const p = peers.get(id);
  if (!p) return;
  try {
    p.pc?.close();
  } catch {
    /* already closed */
  }
  peers.delete(id);
  notify();
}

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
  await peer.pc!.setRemoteDescription(answer);
}

export function closePeer(id: string) {
  const p = peers.get(id);
  if (!p) return;
  p.dc?.close();
  p.pc?.close();
  p.state = 'closed';
  peers.delete(id);
  notify();
}

function addPeer(pc: RTCPeerConnection): Peer {
  const peer: Peer = { id: crypto.randomUUID(), remoteNodeId: null, how: 'code', createdAt: Date.now(), pc, dc: null, state: 'connecting', sent: 0, received: 0 };
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
    const s = await getSession();
    // who we are, so the other phone can say "Receiving from <user ID>" (decisions.md 13.3)
    send(peer, { t: 'hello', nodeId: n?.id ?? 'unprovisioned', user: s?.user.username ?? null, name: s?.user.name ?? null });
    await sendSummary(peer);
  };
  dc.onclose = () => {
    peer.state = 'closed';
    notify();
  };
  dc.onmessage = (e) => void onMessage(peer, e.data as string);
}

function send(peer: Peer, obj: unknown) {
  if (peer.sendRaw) {
    if (peer.state === 'open') peer.sendRaw(JSON.stringify(obj));
  } else if (peer.dc?.readyState === 'open') peer.dc.send(JSON.stringify(obj));
}

/* ------------------- other transports (Android app: nearby.ts) ------------------- */

/** A link made by another transport: register it, then say hello and exchange summaries. */
export async function openExternalPeer(id: string, how: Peer['how'], sendRaw: (text: string) => void): Promise<Peer> {
  const old = peers.get(id);
  if (old && old.state === 'open') return old;
  const peer: Peer = { id, remoteNodeId: null, how, createdAt: Date.now(), pc: null, dc: null, sendRaw, state: 'open', sent: 0, received: 0 };
  peers.set(id, peer);
  notify();
  const n = await getRelayNode();
  const s = await getSession();
  send(peer, { t: 'hello', nodeId: n?.id ?? 'unprovisioned', user: s?.user.username ?? null, name: s?.user.name ?? null });
  await sendSummary(peer);
  return peer;
}

/** One complete protocol message received over another transport. */
export function externalMessage(id: string, text: string) {
  const p = peers.get(id);
  if (p) void onMessage(p, text);
}

export function closeExternalPeer(id: string) {
  const p = peers.get(id);
  if (!p) return;
  p.state = 'closed';
  peers.delete(id);
  notify();
}

async function sendSummary(peer: Peer, pull = true) {
  const n = await getRelayNode();
  if (n) send(peer, { t: 'summary', seen: n.summary().seen, pull });
}

/* ------------------- what moved, in plain words (decisions.md 13.3) ------------------- */

const KIND_NAME: Record<string, string> = { sos: 'SOS', report: 'field report', missing: 'missing-person report', allotment: 'provisional allotment' };

/** "SOS, field report and 2 photos" */
export function describeMessages(msgs: MeshMessage[]): string {
  const counts = new Map<string, number>();
  const photos = new Set<string>();
  for (const m of msgs) {
    if (m.type === 'photo_chunk' || m.type === 'photo_thumb') {
      if (m.chunkInfo) photos.add(m.chunkInfo.photoId);
    } else if (m.type !== 'ack') counts.set(m.type, (counts.get(m.type) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([t, c]) => (c === 1 ? KIND_NAME[t] ?? t : `${c} ${KIND_NAME[t] ?? t}s`));
  if (photos.size) parts.push(photos.size === 1 ? '1 photo' : `${photos.size} photos`);
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/** Whose message it is, from the content (the envelope only knows device ids). */
function madeBy(msgs: MeshMessage[]): string {
  const who = new Set<string>();
  for (const m of msgs) {
    const p = m.payload as { profile?: { name?: string }; teamId?: string; person?: { name?: string } };
    if (m.type === 'sos' && p.profile?.name) who.add(p.profile.name);
    if (m.type === 'report' && p.teamId) who.add(p.teamId);
    if (m.type === 'missing' && p.person?.name) who.add(`about ${p.person.name}`);
  }
  return who.size ? ` (${[...who].join(', ')})` : '';
}

export function peerLabel(p: Peer): string {
  return p.remoteUser ?? 'a nearby phone';
}

const incoming = new Map<string, { msgs: MeshMessage[]; hop: number; timer: ReturnType<typeof setTimeout> }>();

/** Batch what one phone sends us for a moment, then show ONE "Receiving from …" message. */
function noteIncoming(peer: Peer, m: MeshMessage) {
  if (m.type === 'ack') return;
  const cur = incoming.get(peer.id) ?? { msgs: [], hop: 0, timer: setTimeout(() => flushIncoming(peer), 700) };
  cur.msgs.push(m);
  cur.hop = Math.max(cur.hop, m.hops + 1);
  incoming.set(peer.id, cur);
}

function flushIncoming(peer: Peer) {
  const cur = incoming.get(peer.id);
  incoming.delete(peer.id);
  if (!cur) return;
  const what = describeMessages(cur.msgs);
  if (!what) return;
  const label = peerLabel(peer);
  toast({
    kind: 'info',
    title: `📥 Receiving from ${label}: ${what}${madeBy(cur.msgs)}`,
    body: `Hop ${cur.hop} between phones. This phone keeps it and passes it on to the control room as soon as it has a connection.`,
    tag: `in-${peer.id}`,
  });
  void logTransfer({ dir: 'in', peer: label, text: `${what}${madeBy(cur.msgs)}`, hops: cur.hop });
}

function noteOutgoing(peer: Peer, msgs: MeshMessage[], ownNodeId: string) {
  const label = peerLabel(peer);
  const own = msgs.filter((x) => x.originNodeId === ownNodeId);
  const others = msgs.filter((x) => x.originNodeId !== ownNodeId);
  const ownWhat = describeMessages(own);
  const otherWhat = describeMessages(others);
  if (ownWhat) {
    toast({
      kind: 'info',
      title: `📶 Connected to ${label} and transferring your ${ownWhat}`,
      body: 'No internet needed. It reaches the control room as soon as any phone in the chain has a connection.',
      tag: `out-own-${peer.id}`,
    });
    void logTransfer({ dir: 'out', peer: label, text: `your ${ownWhat}`, hops: 1 });
  }
  if (otherWhat) {
    toast({ kind: 'info', title: `📶 Connected to ${label} – passing on ${otherWhat} from other phones${madeBy(others)}`, tag: `out-fwd-${peer.id}` });
    void logTransfer({ dir: 'out', peer: label, text: `${otherWhat} from other phones${madeBy(others)}`, hops: Math.max(...others.map((x) => x.hops + 1)) });
  }
}

/** A signed control-room confirmation for one of OUR items arrived through another phone. */
async function noteConfirmation(peer: Peer, m: MeshMessage) {
  const ack = m.payload as { clientId?: string; serverId?: string; kind?: string };
  if (!ack.clientId) return;
  const own = await db.outbox.get(ack.clientId);
  if (!own || own.status !== 'received') return;
  const label = peerLabel(peer);
  const what = KIND_NAME[own.kind] ?? own.kind;
  toast({
    kind: 'ok',
    title: `✅ The control room confirmed your ${what} (${ack.serverId})`,
    body: `The confirmation came back through ${label}'s phone – your phone never needed internet.`,
    tag: `ack-${ack.clientId}`,
  });
  void logTransfer({ dir: 'confirm', peer: label, text: `control room confirmed your ${what} (${ack.serverId})` });
}

async function onMessage(peer: Peer, raw: string) {
  let m: { t: string; nodeId?: string; user?: string | null; name?: string | null; seen?: string[]; pull?: boolean; m?: MeshMessage };
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  const n = await getRelayNode();
  if (!n) return;
  if (m.t === 'hello') {
    peer.remoteNodeId = m.nodeId ?? null;
    peer.remoteUser = typeof m.user === 'string' ? m.user.slice(0, 40) : null;
    peer.remoteName = typeof m.name === 'string' ? m.name.slice(0, 80) : null;
    notify();
  } else if (m.t === 'summary' && Array.isArray(m.seen)) {
    const summary: MeshSummary = { nodeId: peer.remoteNodeId ?? '?', seen: m.seen };
    const msgs = n.messagesFor(summary, 200);
    for (const msg of msgs) send(peer, { t: 'msg', m: msg });
    peer.sent += msgs.length;
    if (msgs.length) noteOutgoing(peer, msgs, n.id);
    // Our own queued items are now "sent (via relay)" – never "received".
    await markSentViaRelay(msgs.filter((x) => x.originNodeId === n.id).map((x) => x.chunkInfo?.photoId ?? x.id));
    // 'pull' = the peer also wants to hear what WE lack, so it can push its new items.
    if (m.pull) await sendSummary(peer, false);
    notify();
  } else if (m.t === 'msg' && m.m) {
    const r = await n.receive(m.m);
    if (r.status === 'accepted') {
      peer.received++;
      if (m.m.type === 'ack') await noteConfirmation(peer, m.m);
      else noteIncoming(peer, m.m);
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
