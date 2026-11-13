/**
 * The phone's own relay node (real, not simulated): one shared `MeshNode`
 * persisted in IndexedDB, fed by
 *   - outbox records / photos created on this phone (originate)
 *   - peers over the EXPERIMENTAL WebRTC LAN link (lan.ts)
 * and drained by
 *   - gatewayUpload(): when this phone is online it uploads what it holds
 *   - learnAcks(): acks from direct sync are wrapped and relayed to peers
 * Verified acks that arrive over the mesh update the outbox (→ received).
 */
import { MeshNode, splitPhoto, toBase64, uuidv7, type Ack, type MeshMessage, type MeshNodeState } from '@rusq/shared';
import { api } from './api.ts';
import { db, kvGet, kvSet, K, type OutboxRow, type PhotoRow } from './db.ts';
import { getAckPublicKey, getTeamKey } from './keys.ts';
import { applyAck } from './outbox.ts';
import { getDeviceId } from './session.ts';

let nodeP: Promise<MeshNode | null> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
const changeListeners = new Set<() => void>();

export function onRelayChange(l: () => void) {
  changeListeners.add(l);
  return () => {
    changeListeners.delete(l);
  };
}
function changed() {
  for (const l of changeListeners) l();
  schedulePersist();
}

/** Returns null until the team key + server key are provisioned (setup screen). */
export function getRelayNode(): Promise<MeshNode | null> {
  if (!nodeP) {
    nodeP = (async () => {
      const [teamKey, serverPublicKey, deviceId] = await Promise.all([getTeamKey(), getAckPublicKey(), getDeviceId()]);
      if (!teamKey || !serverPublicKey) return null;
      const node = new MeshNode({
        nodeId: deviceId,
        teamKey,
        serverPublicKey,
        now: () => Date.now(),
        newId: () => uuidv7(),
        onAck: async (ack) => {
          await applyAck(ack); // re-verifies with the cached key before marking received
        },
        // Other phones' messages exist nowhere else on this phone: persist them right away
        // (photo-chunk bursts are debounced to spare the battery).
        onAccept: async (m) => {
          if (m.type !== 'photo_chunk') await kvSet(K.meshState, node.exportState());
          changed();
        },
      });
      const st = await kvGet<MeshNodeState>(K.meshState);
      if (st) node.importState(st);
      await selfHeal(node);
      return node;
    })().catch(() => null);
    nodeP.then((n) => {
      if (!n) nodeP = null; // retry after provisioning
    });
  }
  return nodeP;
}

/**
 * IndexedDB outbox is the source of truth. If the app was closed before the
 * relay state was saved, re-originate every unconfirmed outbox item so it can
 * still travel over the LAN link. Same ids → peers dedupe.
 */
async function selfHeal(node: MeshNode) {
  let healed = 0;
  for (const row of await db.outbox.toArray()) {
    if (row.status === 'received' || node.has(row.id) || node.isAcked(row.id)) continue;
    await node.originate(row.kind, row.data);
    healed++;
  }
  for (const p of await db.photos.toArray()) {
    if (p.status === 'received' || node.isAcked(p.id) || node.held().some((m) => m.chunkInfo?.photoId === p.id)) continue;
    await originatePhotoOn(node, p);
    healed++;
  }
  if (healed) await kvSet(K.meshState, node.exportState());
}

export function resetRelayNode() {
  nodeP = null;
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    await persistNow();
  }, 500);
}

export async function persistNow() {
  const n = await getRelayNode();
  if (n) await kvSet(K.meshState, n.exportState());
}

export async function originateRecord(kind: OutboxRow['kind'], data: OutboxRow['data']) {
  const n = await getRelayNode();
  if (!n || n.has(data.id)) return;
  await n.originate(kind, data);
  await persistNow(); // immediately – the user may close the app right after saving
  changed();
}

/** Thumbnail first (priority 2), then the full image in resumable chunks (priority 3). */
export async function originatePhoto(p: PhotoRow) {
  const n = await getRelayNode();
  if (!n) return;
  await originatePhotoOn(n, p);
  await persistNow();
  changed();
}

async function originatePhotoOn(n: MeshNode, p: PhotoRow) {
  const thumbBytes = new Uint8Array(p.thumbBytes);
  const thumbInfo = (await splitPhoto(thumbBytes, p.id, p.reportId, thumbBytes.length || 1))[0]!;
  await n.originate('photo_thumb', { data: thumbInfo.data, mime: 'image/jpeg' }, { chunkInfo: thumbInfo.info });
  const bytes = new Uint8Array(p.bytes);
  for (const c of await splitPhoto(bytes, p.id, p.reportId)) {
    await n.originate('photo_chunk', { data: c.data, mime: 'image/jpeg' }, { chunkInfo: c.info });
  }
}

/** Acks obtained by direct sync: stop forwarding those items and tell peers. */
export async function learnAcks(acks: Ack[]) {
  const n = await getRelayNode();
  if (!n) return;
  if ((await n.ingestServerAcks(acks)) > 0) changed();
}

/** Gateway: upload everything we hold for others, relay the acks back. */
export async function gatewayUpload(): Promise<number> {
  const n = await getRelayNode();
  if (!n) return 0;
  let uploaded = 0;
  for (;;) {
    // Only what OTHER phones handed us: our own items go through direct sync (/api/sync, photo PUT).
    const pending = n.pendingUploads().filter((m) => m.originNodeId !== n.id).slice(0, 100);
    if (pending.length === 0) break;
    const r = await api<{ acks: Ack[]; rejected: { id: string; reason: string }[] }>('/mesh/upload', {
      method: 'POST',
      body: JSON.stringify({ envelopes: pending }),
      timeoutMs: 30_000,
    });
    uploaded += pending.length;
    await n.ingestServerAcks(r.acks);
    for (const a of r.acks) await applyAck(a);
    // Anything rejected or still incomplete (photo chunks waiting for siblings) stays held.
    const progressed = r.acks.length > 0;
    if (!progressed) break;
  }
  changed();
  return uploaded;
}

export interface RelayInfo {
  held: MeshMessage[];
  stats: MeshNode['stats'];
  nodeId: string;
}

export async function relayInfo(): Promise<RelayInfo | null> {
  const n = await getRelayNode();
  if (!n) return null;
  return { held: n.held(), stats: n.stats, nodeId: n.id };
}

/** Utility for the LAN link: is this message one of OUR outbox items? */
export async function ownOutboxIds(ids: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids) if ((await db.outbox.get(id)) || (await db.photos.get(id))) out.push(id);
  return out;
}

export { toBase64 };
