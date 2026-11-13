/**
 * SIMULATED multi-hop mesh (§2.2, §8A). NOT a real radio mesh.
 *
 * Runs real `MeshNode` instances (real envelopes, real MACs, real server ack
 * signatures) over a virtual radio: nodes on a 2-D plane are linked when within
 * `range`, links can be forced down, packets are lost / delayed / duplicated /
 * reordered according to a SEEDED RNG, so every run is reproducible.
 *
 * Used by: the Mesh Lab page (apps/web) and the seeded simulation tests.
 */
import type { Ack } from '../schemas.ts';
import { signAck } from './crypto.ts';
import type { MeshMessage } from './envelope.ts';
import { Reassembler } from './chunks.ts';
import { MeshNode } from './node.ts';
import { mulberry32, seededUuid } from './rng.ts';

export interface SimNodeSpec {
  id: string;
  x: number;
  y: number;
  gateway?: boolean;
  /** gateway only gets internet from this tick on ("gateway appearing late") */
  gatewayFromTick?: number;
  /** wall-clock skew of this phone in ms (clock skew scenario) */
  clockSkewMs?: number;
  /** node starts switched off */
  down?: boolean;
}

export type SimEvent =
  | { tick: number; kind: 'node_down' | 'node_up'; nodeId: string }
  | { tick: number; kind: 'link_down' | 'link_up'; a: string; b: string }
  | { tick: number; kind: 'partition'; groups: string[][] }
  | { tick: number; kind: 'heal' }
  | { tick: number; kind: 'move'; nodeId: string; x: number; y: number }
  | { tick: number; kind: 'gateway'; nodeId: string; on: boolean };

export interface SimConfig {
  seed: number;
  nodes: SimNodeSpec[];
  range: number;
  /** 0..1 probability each packet is lost */
  loss: number;
  /** delivery delay in ticks, uniform in [min,max] */
  latency: [number, number];
  /** probability a delivered packet is delivered twice */
  duplicateRate?: number;
  /** max messages per link direction per tick (priority matters when small) */
  bandwidth?: number;
  /** gateway uploads per tick */
  uploadBatch?: number;
  events?: SimEvent[];
  tickMs?: number;
}

export interface SimServerRecord {
  clientId: string;
  kind: Ack['kind'];
  serverId: string;
  firstTick: number;
  receivedCount: number;
}

export interface SimSnapshot {
  tick: number;
  nodes: { id: string; x: number; y: number; up: boolean; gateway: boolean; held: number }[];
  links: { a: string; b: string }[];
  inFlight: number;
  serverRecords: number;
}

interface Packet {
  to: string;
  from: string;
  msg: MeshMessage;
  arriveTick: number;
  order: number;
}

/** In-simulation server: dedups by clientId and returns ECDSA-signed acks. */
export class SimServer {
  readonly records = new Map<string, SimServerRecord>();
  private counter = 0;
  private reassembler = new Reassembler();
  constructor(private readonly privateKey: CryptoKey) {}

  async upload(msgs: MeshMessage[], tick: number): Promise<Ack[]> {
    const acks: Ack[] = [];
    for (const m of msgs) {
      let kind: Ack['kind'] | null = null;
      let clientId = m.id;
      if (m.type === 'sos' || m.type === 'report' || m.type === 'allotment') kind = m.type;
      else if (m.type === 'photo_chunk') {
        kind = 'photo';
        clientId = m.chunkInfo!.photoId;
        if (!this.records.has(clientId)) {
          const r = await this.reassembler.add(m);
          if (r.state !== 'complete') continue;
        }
      } else continue; // thumbs are a relay-only preview
      const existing = this.records.get(clientId);
      if (existing) {
        existing.receivedCount += 1;
      } else {
        this.records.set(clientId, { clientId, kind, serverId: `srv-${++this.counter}`, firstTick: tick, receivedCount: 1 });
      }
      const rec = this.records.get(clientId)!;
      acks.push(
        await signAck(this.privateKey, {
          clientId,
          kind,
          serverId: rec.serverId,
          receivedAt: new Date(tick * 1000).toISOString(),
          duplicate: !!existing,
        }),
      );
    }
    return acks;
  }
}

export class MeshSimulator {
  readonly nodes = new Map<string, MeshNode>();
  readonly specs = new Map<string, SimNodeSpec & { up: boolean; gatewayOn: boolean }>();
  readonly server: SimServer;
  tick = 0;
  private rng: () => number;
  private inFlight: Packet[] = [];
  private forcedDown = new Set<string>();
  private partition: Map<string, number> | null = null;
  private order = 0;
  /** per-node count of onAccept calls by id – used to prove no duplicate delivery */
  readonly deliveries = new Map<string, Map<string, number>>();
  readonly log: string[] = [];
  /** total packets put on the air (for "no infinite forwarding" checks) */
  transmissions = 0;

  constructor(
    readonly cfg: SimConfig,
    teamKey: CryptoKey,
    serverPrivateKey: CryptoKey,
    serverPublicKey: CryptoKey,
  ) {
    this.rng = mulberry32(cfg.seed);
    const idGen = seededUuid(mulberry32(cfg.seed ^ 0x9e3779b9));
    this.server = new SimServer(serverPrivateKey);
    const tickMs = cfg.tickMs ?? 1000;
    for (const spec of cfg.nodes) {
      const s = { ...spec, up: !spec.down, gatewayOn: !!spec.gateway && (spec.gatewayFromTick ?? 0) <= 0 };
      this.specs.set(spec.id, s);
      const dmap = new Map<string, number>();
      this.deliveries.set(spec.id, dmap);
      this.nodes.set(
        spec.id,
        new MeshNode({
          nodeId: spec.id,
          teamKey,
          serverPublicKey,
          now: () => 1_700_000_000_000 + this.tick * tickMs + (spec.clockSkewMs ?? 0),
          newId: idGen,
          onAccept: (m) => {
            dmap.set(m.id, (dmap.get(m.id) ?? 0) + 1);
          },
        }),
      );
    }
  }

  node(id: string): MeshNode {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`no node ${id}`);
    return n;
  }

  /** Current radio links (both ends up, in range, not forced down, same partition). */
  links(): { a: string; b: string }[] {
    const ids = [...this.specs.keys()].sort();
    const out: { a: string; b: string }[] = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = this.specs.get(ids[i]!)!;
        const b = this.specs.get(ids[j]!)!;
        if (!a.up || !b.up) continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) > this.cfg.range) continue;
        if (this.forcedDown.has(linkKey(a.id, b.id))) continue;
        if (this.partition && this.partition.get(a.id) !== this.partition.get(b.id)) continue;
        out.push({ a: a.id, b: b.id });
      }
    }
    return out;
  }

  async step(): Promise<void> {
    this.tick += 1;
    this.applyEvents();

    // 1. deliver packets that arrive now, in seeded-shuffled order (out-of-order delivery)
    const arriving = this.inFlight.filter((p) => p.arriveTick <= this.tick);
    this.inFlight = this.inFlight.filter((p) => p.arriveTick > this.tick);
    shuffle(arriving, this.rng);
    for (const p of arriving) {
      if (!this.specs.get(p.to)?.up) continue; // receiver switched off – packet lost
      await this.node(p.to).receive(p.msg);
    }

    // 2. anti-entropy over every live link (both directions)
    const bw = this.cfg.bandwidth ?? Infinity;
    for (const { a, b } of this.links()) {
      for (const [from, to] of [
        [a, b],
        [b, a],
      ] as const) {
        if (this.rng() < this.cfg.loss) continue; // summary lost → no exchange this tick
        const toSummary = this.node(to).summary();
        const inFlightIds = new Set(this.inFlight.filter((p) => p.to === to).map((p) => p.msg.id));
        const msgs = this.node(from)
          .messagesFor({ ...toSummary, seen: [...toSummary.seen, ...inFlightIds] }, bw);
        for (const msg of msgs) {
          this.transmissions += 1;
          if (this.rng() < this.cfg.loss) continue;
          const [lo, hi] = this.cfg.latency;
          const delay = lo + Math.floor(this.rng() * (hi - lo + 1));
          this.inFlight.push({ to, from, msg, arriveTick: this.tick + delay, order: this.order++ });
          if (this.cfg.duplicateRate && this.rng() < this.cfg.duplicateRate) {
            this.inFlight.push({ to, from, msg, arriveTick: this.tick + delay + 1, order: this.order++ });
          }
        }
      }
    }

    // 3. gateways with internet upload what they hold and relay acks back
    for (const [id, spec] of this.specs) {
      if (!spec.up || !spec.gatewayOn) continue;
      const node = this.node(id);
      const pending = node.pendingUploads().slice(0, this.cfg.uploadBatch ?? 50);
      if (pending.length === 0) continue;
      const acks = await this.server.upload(pending, this.tick);
      await node.ingestServerAcks(acks);
    }
  }

  async run(maxTicks: number, until?: () => boolean): Promise<number> {
    while (this.tick < maxTicks) {
      if (until?.()) break;
      await this.step();
    }
    return this.tick;
  }

  snapshot(): SimSnapshot {
    return {
      tick: this.tick,
      nodes: [...this.specs.values()].map((s) => ({
        id: s.id,
        x: s.x,
        y: s.y,
        up: s.up,
        gateway: s.gatewayOn,
        held: this.node(s.id).heldCount(),
      })),
      links: this.links(),
      inFlight: this.inFlight.length,
      serverRecords: this.server.records.size,
    };
  }

  /** Mutators used by the Mesh Lab UI. */
  setPosition(id: string, x: number, y: number) {
    const s = this.specs.get(id);
    if (s) Object.assign(s, { x, y });
  }
  setUp(id: string, up: boolean) {
    const s = this.specs.get(id);
    if (s) s.up = up;
  }
  setGateway(id: string, on: boolean) {
    const s = this.specs.get(id);
    if (s) s.gatewayOn = on;
  }
  setLink(a: string, b: string, up: boolean) {
    if (up) this.forcedDown.delete(linkKey(a, b));
    else this.forcedDown.add(linkKey(a, b));
  }
  setPartition(groups: string[][] | null) {
    if (!groups) {
      this.partition = null;
      return;
    }
    this.partition = new Map();
    groups.forEach((g, i) => g.forEach((id) => this.partition!.set(id, i)));
  }

  private applyEvents() {
    for (const [id, s] of this.specs) {
      if (s.gateway && s.gatewayFromTick !== undefined && s.gatewayFromTick === this.tick) {
        s.gatewayOn = true;
        this.log.push(`t${this.tick}: gateway ${id} online`);
      }
    }
    for (const e of this.cfg.events ?? []) {
      if (e.tick !== this.tick) continue;
      this.log.push(`t${this.tick}: ${e.kind}`);
      switch (e.kind) {
        case 'node_down':
          this.setUp(e.nodeId, false);
          break;
        case 'node_up':
          this.setUp(e.nodeId, true);
          break;
        case 'link_down':
          this.setLink(e.a, e.b, false);
          break;
        case 'link_up':
          this.setLink(e.a, e.b, true);
          break;
        case 'partition':
          this.setPartition(e.groups);
          break;
        case 'heal':
          this.setPartition(null);
          break;
        case 'move':
          this.setPosition(e.nodeId, e.x, e.y);
          break;
        case 'gateway':
          this.setGateway(e.nodeId, e.on);
          break;
      }
    }
  }
}

function linkKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function shuffle<T>(arr: T[], rng: () => number) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
}

/* ----------------------------- topologies ----------------------------- */

/** Nodes spaced `gap` apart on a line; range must be ≥ gap and < 2·gap for a true multi-hop line. */
export function lineTopology(n: number, gap = 10): SimNodeSpec[] {
  return Array.from({ length: n }, (_, i) => ({ id: `n${String(i).padStart(2, '0')}`, x: i * gap, y: 0 }));
}

/** Hub n00 at the centre, leaves on a circle of radius r. */
export function starTopology(n: number, r = 10): SimNodeSpec[] {
  const out: SimNodeSpec[] = [{ id: 'n00', x: 0, y: 0 }];
  for (let i = 1; i < n; i++) {
    const a = (2 * Math.PI * i) / (n - 1);
    out.push({ id: `n${String(i).padStart(2, '0')}`, x: r * Math.cos(a), y: r * Math.sin(a) });
  }
  return out;
}

/** Random geometric graph in a size×size square (seeded). */
export function randomTopology(n: number, size: number, seed: number): SimNodeSpec[] {
  const rng = mulberry32(seed);
  return Array.from({ length: n }, (_, i) => ({ id: `n${String(i).padStart(2, '0')}`, x: rng() * size, y: rng() * size }));
}

/** BFS over a links list: is there a path from `from` to any node in `to`? */
export function connected(links: { a: string; b: string }[], from: string, to: Set<string>): boolean {
  const adj = new Map<string, string[]>();
  for (const { a, b } of links) {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }
  const seen = new Set([from]);
  const q = [from];
  while (q.length) {
    const x = q.shift()!;
    if (to.has(x)) return true;
    for (const y of adj.get(x) ?? []) if (!seen.has(y)) (seen.add(y), q.push(y));
  }
  return false;
}
