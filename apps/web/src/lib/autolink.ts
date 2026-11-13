/**
 * AUTOMATIC nearby-phone links (decisions.md 12.10) – no QR code, no copy-paste.
 *
 * Every few seconds while this phone can reach the server, it checks in (POST /api/peer/poll).
 * The server answers with the other RusQ phones on the SAME network (same Wi-Fi or hotspot)
 * and passes WebRTC offers/answers between them. As soon as two phones are "in range" this
 * way, they connect by themselves. The link uses local addresses only, so it KEEPS WORKING
 * when the internet or the server disappears – messages then hop phone to phone (relay.ts).
 *
 * Honest limit: browsers cannot find each other with NO server at all (no Bluetooth/Wi-Fi
 * scanning in web apps). Phones that never were online on the same network together can
 * still connect with the code on the Nearby phones screen.
 *
 * Who links: people needing help and rescuers (the control room is online anyway).
 * The phone with the smaller node id makes the offer, so two phones never offer at once.
 */
import { api } from './api.ts';
import { currentReach } from './connectivity.ts';
import { acceptInvite, completeInvite, createInvite, forgetPeer, listPeers, type Peer } from './lan.ts';
import { getRelayNode } from './relay.ts';
import { getSession } from './session.ts';

export const POLL_MS = 4000;
const CONNECT_TIMEOUT_MS = 20_000;

interface Signal {
  to: string;
  type: 'offer' | 'answer';
  sdp: string;
  linkId: string;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let outQueue: Signal[] = [];
/** offers we made, by linkId */
const offers = new Map<string, { peer: Peer; to: string }>();
let lastSeen: string[] = [];
const listeners = new Set<(peers: string[]) => void>();

/** Phones the server currently sees on this network (for the screen). */
export function nearbySeen(): string[] {
  return lastSeen;
}
export function onNearbySeen(l: (peers: string[]) => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function linkTo(nodeId: string): Peer | undefined {
  return listPeers().find((p) => (p.remoteNodeId === nodeId || p.expectedNodeId === nodeId) && p.state !== 'closed');
}

/** One check-in round. Exported for tests. */
export async function autoLinkRound(): Promise<void> {
  if (typeof RTCPeerConnection === 'undefined') return;
  const session = await getSession();
  if (!session || session.user.role === 'admin') return;
  if (currentReach() !== 'online') return;
  const node = await getRelayNode();
  if (!node) return; // no team key yet ("Ready for offline")

  // Drop links that died or never came up, so they can be retried.
  for (const p of listPeers()) {
    if (p.how !== 'auto') continue;
    if (p.state === 'closed' || (p.state === 'connecting' && Date.now() - p.createdAt > CONNECT_TIMEOUT_MS)) {
      for (const [k, o] of offers) if (o.peer.id === p.id) offers.delete(k);
      forgetPeer(p.id);
    }
  }

  const out = outQueue;
  outQueue = [];
  let res: { peers: string[]; inbox: { from: string; type: 'offer' | 'answer'; sdp: string; linkId: string }[] };
  try {
    res = await api('/peer/poll', { method: 'POST', body: JSON.stringify({ nodeId: node.id, out }), timeoutMs: 8000 });
  } catch {
    outQueue = [...out, ...outQueue].slice(-10); // try again next round
    return;
  }
  lastSeen = res.peers;
  for (const l of listeners) l(lastSeen);

  for (const m of res.inbox) {
    try {
      if (m.type === 'offer') {
        if (linkTo(m.from)?.state === 'open') continue;
        const { peer, reply } = await acceptInvite(m.sdp);
        peer.how = 'auto';
        peer.expectedNodeId = m.from;
        outQueue.push({ to: m.from, type: 'answer', sdp: reply, linkId: m.linkId });
      } else {
        const o = offers.get(m.linkId);
        if (!o || o.to !== m.from) continue;
        offers.delete(m.linkId);
        await completeInvite(o.peer, m.sdp);
      }
    } catch {
      /* a broken offer/answer – the link is retried after the timeout */
    }
  }

  for (const other of res.peers) {
    if (node.id >= other) continue; // the smaller id offers
    if (linkTo(other)) continue;
    try {
      const { peer, code } = await createInvite();
      peer.how = 'auto';
      peer.expectedNodeId = other;
      const linkId = crypto.randomUUID();
      offers.set(linkId, { peer, to: other });
      outQueue.push({ to: other, type: 'offer', sdp: code, linkId });
    } catch {
      /* WebRTC not available right now */
    }
  }

  // Answers/offers created this round go out right away (don't wait a whole interval).
  if (outQueue.length) {
    const again = outQueue;
    outQueue = [];
    try {
      await api('/peer/poll', { method: 'POST', body: JSON.stringify({ nodeId: node.id, out: again }), timeoutMs: 8000 });
    } catch {
      outQueue = again;
    }
  }
}

/** Start the background loop (main.tsx). Cheap: one small request every few seconds while online. */
export function startAutoLink() {
  if (timer || typeof window === 'undefined') return;
  const loop = async () => {
    if (!running) {
      running = true;
      await autoLinkRound().catch(() => {});
      running = false;
    }
    timer = setTimeout(loop, document.visibilityState === 'hidden' ? POLL_MS * 3 : POLL_MS);
  };
  timer = setTimeout(loop, 1500);
}
