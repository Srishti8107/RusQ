/**
 * Seeded SIMULATED-mesh scenarios (§9). Every run is reproducible from its seed.
 * Gate 1 exit criterion 4: delivery in every connected-path scenario.
 */
import { describe, expect, it } from 'vitest';
import {
  connected,
  lineTopology,
  MeshSimulator,
  randomTopology,
  splitPhoto,
  starTopology,
  type SimConfig,
  type SimNodeSpec,
} from '../src/index.ts';
import { keys, sampleReport, sampleSos } from './helpers.ts';

function uid(n: number): string {
  return `01890000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
}

async function sim(cfg: SimConfig) {
  const k = await keys();
  return new MeshSimulator(cfg, k.teamKey, k.serverPriv, k.serverPub);
}

/** Originates one SOS per listed node, returns the ids. */
async function seedSos(s: MeshSimulator, nodeIds: string[], start = 1): Promise<string[]> {
  const ids: string[] = [];
  let i = start;
  for (const nid of nodeIds) {
    const id = uid(i++);
    await s.node(nid).originate('sos', sampleSos(id));
    ids.push(id);
  }
  return ids;
}

const allAtServer = (s: MeshSimulator, ids: string[]) => () => ids.every((id) => s.server.records.has(id));
const allOriginsAcked = (s: MeshSimulator, pairs: [string, string][]) => () => pairs.every(([n, id]) => s.node(n).isAcked(id));

function assertNoDuplicateDelivery(s: MeshSimulator) {
  for (const [nodeId, m] of s.deliveries) for (const [id, c] of m) expect(c, `${nodeId} got ${id} ${c}×`).toBe(1);
  for (const rec of s.server.records.values()) expect(rec.kind).toBeTruthy();
}

/** After quiescence nothing is transmitted any more (no infinite forwarding). */
async function assertQuiesces(s: MeshSimulator, ticks = 15) {
  await s.run(s.tick + ticks); // let acks propagate fully
  const before = s.transmissions;
  await s.run(s.tick + ticks);
  expect(s.transmissions - before).toBe(0);
}

describe('seeded mesh simulations (SIMULATED)', () => {
  it('line, 20 nodes, no loss: SOS hops end-to-end and the ack returns to the origin', async () => {
    const nodes = lineTopology(20, 10);
    nodes[19]!.gateway = true;
    const s = await sim({ seed: 1, nodes, range: 12, loss: 0, latency: [1, 1] });
    const [id] = await seedSos(s, ['n00']);
    await s.run(200, allOriginsAcked(s, [['n00', id!]]));
    expect(s.server.records.get(id!)).toBeTruthy();
    expect(s.node('n00').isAcked(id!)).toBe(true);
    expect(s.tick).toBeLessThan(60); // 19 hops out + 19 back
    assertNoDuplicateDelivery(s);
    await assertQuiesces(s);
  });

  it.each([0.1, 0.25, 0.4])('line, 30 nodes, %s packet loss: still delivered', async (loss) => {
    const nodes = lineTopology(30, 10);
    nodes[29]!.gateway = true;
    const s = await sim({ seed: 42, nodes, range: 12, loss, latency: [1, 2] });
    const ids = await seedSos(s, ['n00', 'n10', 'n20']);
    await s.run(1000, allAtServer(s, ids));
    for (const id of ids) expect(s.server.records.has(id)).toBe(true);
    assertNoDuplicateDelivery(s);
  });

  it('star, 25 nodes, gateway is a leaf: every leaf reaches it through the hub', async () => {
    const nodes = starTopology(25, 10);
    nodes[7]!.gateway = true;
    const s = await sim({ seed: 7, nodes, range: 11, loss: 0.2, latency: [1, 3] });
    const origins = nodes.filter((n) => !n.gateway).map((n) => n.id);
    const ids = await seedSos(s, origins);
    await s.run(500, allAtServer(s, ids));
    expect(s.server.records.size).toBe(ids.length);
    assertNoDuplicateDelivery(s);
    await assertQuiesces(s);
  });

  it.each([1, 2, 3])('random geometric 50 nodes (seed %i): every node connected to a gateway delivers', async (seed) => {
    const nodes = randomTopology(50, 100, seed);
    nodes[0]!.gateway = true;
    const s = await sim({ seed, nodes, range: 22, loss: 0.15, latency: [1, 3], duplicateRate: 0.1 });
    const links = s.links();
    const gws = new Set(['n00']);
    const reachable = nodes.filter((n) => connected(links, n.id, gws)).map((n) => n.id);
    const unreachable = nodes.filter((n) => !connected(links, n.id, gws)).map((n) => n.id);
    expect(reachable.length).toBeGreaterThan(20);
    const ids = await seedSos(s, reachable);
    const lost = await seedSos(s, unreachable, 1000);
    await s.run(600, allAtServer(s, ids));
    for (const id of ids) expect(s.server.records.has(id)).toBe(true);
    for (const id of lost) expect(s.server.records.has(id)).toBe(false); // honest: no path, no delivery
    assertNoDuplicateDelivery(s);
  });

  it('node churn: intermediate nodes switch off and on; messages still get through', async () => {
    const nodes = lineTopology(20, 10);
    nodes[19]!.gateway = true;
    const events: SimConfig['events'] = [];
    for (let t = 2; t < 120; t += 6) {
      const victim = `n${String(3 + ((t * 7) % 15)).padStart(2, '0')}`;
      events.push({ tick: t, kind: 'node_down', nodeId: victim }, { tick: t + 3, kind: 'node_up', nodeId: victim });
    }
    const s = await sim({ seed: 9, nodes, range: 12, loss: 0.1, latency: [1, 2], events });
    const ids = await seedSos(s, ['n00', 'n05']);
    await s.run(800, allAtServer(s, ids));
    for (const id of ids) expect(s.server.records.has(id)).toBe(true);
  });

  it('partition then heal: nothing crosses during the partition, everything after', async () => {
    const nodes = lineTopology(10, 10);
    nodes[9]!.gateway = true;
    const left = nodes.slice(0, 5).map((n) => n.id);
    const right = nodes.slice(5).map((n) => n.id);
    const s = await sim({
      seed: 3,
      nodes,
      range: 12,
      loss: 0,
      latency: [1, 1],
      events: [
        { tick: 1, kind: 'partition', groups: [left, right] },
        { tick: 40, kind: 'heal' },
      ],
    });
    const ids = await seedSos(s, ['n00']);
    await s.run(39);
    expect(s.server.records.has(ids[0]!)).toBe(false);
    await s.run(200, allAtServer(s, ids));
    expect(s.server.records.has(ids[0]!)).toBe(true);
  });

  it('two gateways: server stores each record once, acks from both are deduplicated', async () => {
    const nodes = lineTopology(11, 10);
    nodes[0]!.gateway = true;
    nodes[10]!.gateway = true;
    const s = await sim({ seed: 11, nodes, range: 12, loss: 0.1, latency: [1, 2] });
    const ids = await seedSos(s, ['n03', 'n05', 'n07']);
    await s.run(300, allOriginsAcked(s, [['n03', ids[0]!], ['n05', ids[1]!], ['n07', ids[2]!]]));
    expect(s.server.records.size).toBe(3);
    for (const id of ids) expect(s.node('n05').isAcked(id)).toBe(true);
    assertNoDuplicateDelivery(s);
    await assertQuiesces(s);
  });

  it('gateway appearing late: messages wait, then flush', async () => {
    const nodes = lineTopology(8, 10);
    nodes[7]!.gateway = true;
    nodes[7]!.gatewayFromTick = 50;
    const s = await sim({ seed: 5, nodes, range: 12, loss: 0, latency: [1, 1] });
    const ids = await seedSos(s, ['n00', 'n02']);
    await s.run(49);
    expect(s.server.records.size).toBe(0);
    expect(s.node('n07').pendingUploads().length).toBe(2); // already relayed to the future gateway
    await s.run(120, allAtServer(s, ids));
    expect(s.server.records.size).toBe(2);
  });

  it('out-of-order and duplicated delivery is harmless', async () => {
    const nodes = lineTopology(6, 10);
    nodes[5]!.gateway = true;
    const s = await sim({ seed: 21, nodes, range: 12, loss: 0, latency: [1, 6], duplicateRate: 0.5 });
    const ids = await seedSos(s, ['n00', 'n00', 'n01', 'n02']);
    await s.node('n00').originate('report', sampleReport(uid(77)));
    ids.push(uid(77));
    await s.run(300, allAtServer(s, ids));
    expect(s.server.records.size).toBe(5);
    const dupes = [...s.nodes.values()].reduce((sum, n) => sum + n.stats.duplicates, 0);
    expect(dupes).toBeGreaterThan(0); // duplicates really happened…
    assertNoDuplicateDelivery(s); // …and were suppressed
  });

  it('photo transfer interrupted and resumed: only missing chunks are re-sent', async () => {
    const nodes: SimNodeSpec[] = [
      { id: 'n00', x: 0, y: 0 },
      { id: 'n01', x: 10, y: 0 },
      { id: 'n02', x: 20, y: 0, gateway: true },
    ];
    const s = await sim({
      seed: 4,
      nodes,
      range: 12,
      loss: 0,
      latency: [1, 1],
      bandwidth: 3,
      events: [
        { tick: 4, kind: 'link_down', a: 'n00', b: 'n01' },
        { tick: 30, kind: 'link_up', a: 'n00', b: 'n01' },
      ],
    });
    const photoId = uid(500);
    const reportId = uid(501);
    const bytes = new Uint8Array(200_000).map((_, i) => (i * 31) % 256);
    const chunks = await splitPhoto(bytes, photoId, reportId, 16 * 1024);
    expect(chunks.length).toBe(13);
    for (const c of chunks) await s.node('n00').originate('photo_chunk', { data: c.data, mime: 'image/jpeg' }, { chunkInfo: c.info });
    await s.run(29);
    const before = s.node('n01').held().filter((m) => m.type === 'photo_chunk').length + (s.server.records.has(photoId) ? 13 : 0);
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(13); // genuinely interrupted mid-transfer
    const txBefore = s.transmissions;
    await s.run(200, () => s.node('n00').isAcked(photoId));
    expect(s.server.records.get(photoId)?.kind).toBe('photo');
    // Resumed: the n00→n01 hop after the outage carried only the missing chunks (+ the ack back).
    const resumeTx = s.transmissions - txBefore;
    expect(resumeTx).toBeLessThan(13 * 2 + 4);
  });

  it('clock skew of hours between nodes does not affect delivery or HLC causality', async () => {
    const H = 3_600_000;
    const nodes = lineTopology(8, 10).map((n, i) => ({ ...n, clockSkewMs: (i % 2 ? 1 : -1) * (i + 1) * H }));
    nodes[7]!.gateway = true;
    const s = await sim({ seed: 13, nodes, range: 12, loss: 0.1, latency: [1, 2] });
    const ids = await seedSos(s, ['n00', 'n06']);
    await s.run(300, allAtServer(s, ids));
    for (const id of ids) expect(s.server.records.has(id)).toBe(true);
    // The gateway's clock is now ≥ every message it has seen (causal order preserved).
    const gwNow = s.node('n07').clock.tick();
    for (const m of s.node('n07').held()) expect(m.createdAt < `${String(gwNow.l).padStart(15, '0')}:zzzzz`).toBe(true);
  });
});
