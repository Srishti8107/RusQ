/**
 * Transport-agnostic store-and-forward relay node (§8A).
 *
 *  - seen-set      : every accepted id; duplicates are dropped (no re-forwarding loops)
 *  - store         : messages this node holds and will forward
 *  - TTL / hops    : a message received with hops ≥ ttl is rejected; held
 *                    messages are only offered to peers while hops < ttl
 *  - anti-entropy  : peers exchange `summary()` (ids only, no payloads) and each
 *                    sends what the other lacks, in priority order
 *  - gateway       : a node with internet uploads everything it holds; verified
 *                    server acks are wrapped in `ack` envelopes and relayed back
 *                    so every node can stop forwarding the acked item
 *  - integrity     : every envelope must carry a valid team-key MAC; acks must
 *                    additionally carry a valid SERVER signature
 */
import type { Ack } from '../schemas.ts';
import { verifyAck } from './crypto.ts';
import {
  DEFAULT_PRIORITY,
  DEFAULT_TTL,
  sendOrder,
  signEnvelope,
  validateEnvelope,
  verifyEnvelope,
  type ChunkInfo,
  type MeshMessage,
  type MeshType,
} from './envelope.ts';
import { HybridLogicalClock, decodeHlc, encodeHlc } from './hlc.ts';

export interface MeshSummary {
  nodeId: string;
  /** ids this node has already accepted (it never needs them again) */
  seen: string[];
}

export type ReceiveResult =
  | { status: 'accepted'; msg: MeshMessage }
  | { status: 'duplicate' }
  | { status: 'rejected'; reason: string };

export interface MeshNodeOptions {
  nodeId: string;
  teamKey: CryptoKey;
  /** Needed to trust relayed acks. Without it, ack envelopes are rejected. */
  serverPublicKey?: CryptoKey;
  now: () => number;
  /** called once per newly accepted message (never for duplicates) */
  onAccept?: (msg: MeshMessage) => void | Promise<void>;
  /** called when a verified server ack arrives for an id */
  onAck?: (ack: Ack) => void | Promise<void>;
  newId: () => string;
  maxStore?: number;
}

export interface MeshNodeState {
  seen: string[];
  store: MeshMessage[];
  acked: Ack[];
  clock: { l: number; c: number };
}

export interface MeshNodeStats {
  accepted: number;
  duplicates: number;
  rejected: Record<string, number>;
  sent: number;
}

export class MeshNode {
  readonly id: string;
  readonly clock: HybridLogicalClock;
  private readonly seen = new Set<string>();
  private readonly store = new Map<string, MeshMessage>();
  /** clientId → verified server ack */
  private readonly acked = new Map<string, Ack>();
  readonly stats: MeshNodeStats = { accepted: 0, duplicates: 0, rejected: {}, sent: 0 };

  constructor(private readonly opts: MeshNodeOptions) {
    this.id = opts.nodeId;
    this.clock = new HybridLogicalClock(opts.nodeId, opts.now);
  }

  /* --------------------------- originate ---------------------------- */

  async originate(
    type: MeshType,
    payload: unknown,
    extra: { id?: string; chunkInfo?: ChunkInfo; ttl?: number; priority?: number } = {},
  ): Promise<MeshMessage> {
    const id = extra.id ?? (payload as { id?: string })?.id ?? this.opts.newId();
    const msg = await signEnvelope(this.opts.teamKey, {
      v: 1,
      id,
      type,
      originNodeId: this.id,
      createdAt: encodeHlc(this.clock.tick()),
      hops: 0,
      ttl: extra.ttl ?? DEFAULT_TTL,
      priority: extra.priority ?? DEFAULT_PRIORITY[type],
      payload,
      chunkInfo: extra.chunkInfo,
    });
    const check = validateEnvelope(msg);
    if (!check.ok) throw new Error(`originate: ${check.reason}`);
    this.seen.add(msg.id);
    if (msg.type === 'ack') this.recordAck(msg.payload as Ack);
    if (!this.isSettled(msg)) this.hold(msg); // acks are never "settled", so they are always held and relayed
    return msg;
  }

  /* ---------------------------- receive ----------------------------- */

  async receive(raw: unknown): Promise<ReceiveResult> {
    const check = validateEnvelope(raw);
    if (!check.ok) return this.reject(check.reason);
    const msg = check.msg;
    if (msg.hops >= msg.ttl) return this.reject('expired (hops ≥ ttl)');
    if (!(await verifyEnvelope(this.opts.teamKey, msg))) return this.reject('bad MAC (unauthenticated)');
    if (this.seen.has(msg.id)) {
      this.stats.duplicates += 1;
      return { status: 'duplicate' };
    }
    if (msg.type === 'ack') {
      const ack = msg.payload as Ack;
      if (!this.opts.serverPublicKey) return this.reject('no server key to verify ack');
      if (!(await verifyAck(this.opts.serverPublicKey, ack))) return this.reject('bad server signature on ack');
    }
    this.seen.add(msg.id);
    this.clock.receive(decodeHlc(msg.createdAt));
    this.stats.accepted += 1;
    const held: MeshMessage = { ...msg, hops: msg.hops + 1 };

    if (msg.type === 'ack') {
      const ack = msg.payload as Ack;
      const isNew = !this.acked.has(ack.clientId);
      this.recordAck(ack);
      if (isNew) {
        this.hold(held); // relay the ack onwards
        await this.opts.onAck?.(ack);
      }
    } else if (!this.isSettled(msg)) {
      this.hold(held);
    }
    await this.opts.onAccept?.(held);
    return { status: 'accepted', msg: held };
  }

  /* -------------------------- anti-entropy -------------------------- */

  summary(): MeshSummary {
    return { nodeId: this.id, seen: [...this.seen] };
  }

  /** Messages the peer lacks, priority-ordered, optionally limited (bandwidth). */
  messagesFor(peer: MeshSummary, limit = Infinity): MeshMessage[] {
    const peerSeen = new Set(peer.seen);
    const out: MeshMessage[] = [];
    for (const m of [...this.store.values()].sort(sendOrder)) {
      if (out.length >= limit) break;
      if (peerSeen.has(m.id)) continue;
      if (m.hops >= m.ttl) continue;
      out.push(m);
    }
    this.stats.sent += out.length;
    return out;
  }

  /* ---------------------------- gateway ----------------------------- */

  /** Items a gateway should upload: held, non-ack, not yet acked. */
  pendingUploads(): MeshMessage[] {
    return [...this.store.values()].filter((m) => m.type !== 'ack' && !this.isSettled(m)).sort(sendOrder);
  }

  /**
   * A gateway calls this with acks returned by the server. Each ack is verified
   * (server signature) and then wrapped in an `ack` envelope that is relayed back.
   */
  async ingestServerAcks(acks: Ack[]): Promise<number> {
    let n = 0;
    for (const ack of acks) {
      if (this.acked.has(ack.clientId)) continue;
      if (!this.opts.serverPublicKey || !(await verifyAck(this.opts.serverPublicKey, ack))) continue;
      await this.originate('ack', ack, { id: this.opts.newId() });
      await this.opts.onAck?.(ack);
      n++;
    }
    return n;
  }

  /* ---------------------------- queries ----------------------------- */

  has(id: string): boolean {
    return this.seen.has(id);
  }
  isAcked(clientId: string): boolean {
    return this.acked.has(clientId);
  }
  getAck(clientId: string): Ack | undefined {
    return this.acked.get(clientId);
  }
  held(): MeshMessage[] {
    return [...this.store.values()].sort(sendOrder);
  }
  heldCount(): number {
    return this.store.size;
  }

  /* -------------------------- persistence --------------------------- */

  exportState(): MeshNodeState {
    return { seen: [...this.seen], store: [...this.store.values()], acked: [...this.acked.values()], clock: this.clock.state() };
  }

  /** Restore persisted state. Stored messages were verified when first accepted. */
  importState(s: MeshNodeState) {
    for (const id of s.seen) this.seen.add(id);
    for (const a of s.acked) this.acked.set(a.clientId, a);
    for (const m of s.store) if (m.type === 'ack' || !this.isSettled(m)) this.store.set(m.id, m);
    this.clock.restore(s.clock);
  }

  /* --------------------------- internals ---------------------------- */

  private isSettled(m: MeshMessage): boolean {
    if (m.type === 'ack') return false;
    if (m.chunkInfo) return this.acked.has(m.chunkInfo.photoId);
    return this.acked.has(m.id);
  }

  private recordAck(ack: Ack) {
    this.acked.set(ack.clientId, ack);
    // Drop everything the ack settles: the record itself, or all parts of a photo.
    for (const [id, m] of this.store) {
      if (m.type === 'ack') continue;
      if (m.id === ack.clientId || m.chunkInfo?.photoId === ack.clientId) this.store.delete(id);
    }
  }

  private hold(m: MeshMessage) {
    this.store.set(m.id, m);
    const max = this.opts.maxStore ?? 5000;
    if (this.store.size > max) {
      // Evict lowest-priority, newest first – SOS and acks are kept longest.
      const victim = [...this.store.values()].sort(sendOrder).at(-1)!;
      this.store.delete(victim.id);
    }
  }

  private reject(reason: string): ReceiveResult {
    const key = reason.split(':')[0]!.split(' (')[0]!;
    this.stats.rejected[key] = (this.stats.rejected[key] ?? 0) + 1;
    return { status: 'rejected', reason };
  }
}
