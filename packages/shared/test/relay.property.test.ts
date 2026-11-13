/**
 * Relay properties (fast-check, §9):
 *  - every message eventually reaches the gateway if a connected path exists
 *  - no duplicate delivery (each node accepts each id at most once; server stores once)
 *  - no infinite forwarding (transmissions stop once everyone has everything)
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { connected, MeshSimulator, type SimNodeSpec } from '../src/index.ts';
import { keys, sampleSos } from './helpers.ts';

const graphArb = fc.record({
  n: fc.integer({ min: 3, max: 16 }),
  range: fc.integer({ min: 15, max: 30 }),
  seed: fc.integer({ min: 1, max: 1_000_000 }),
  loss: fc.double({ min: 0, max: 0.4, noNaN: true }),
  latencyMax: fc.integer({ min: 1, max: 4 }),
  dup: fc.double({ min: 0, max: 0.3, noNaN: true }),
  positions: fc.array(fc.tuple(fc.integer({ min: 0, max: 50 }), fc.integer({ min: 0, max: 50 })), { minLength: 16, maxLength: 16 }),
  originMask: fc.array(fc.boolean(), { minLength: 16, maxLength: 16 }),
});

describe('relay properties (SIMULATED mesh)', () => {
  it('eventual delivery, no duplicates, no infinite forwarding', async () => {
    const k = await keys();
    const coverage = { runs: 0, delivered: 0, unreachable: 0, multiHop: 0 };
    await fc.assert(
      fc.asyncProperty(graphArb, async (g) => {
        const nodes: SimNodeSpec[] = Array.from({ length: g.n }, (_, i) => ({
          id: `n${String(i).padStart(2, '0')}`,
          x: g.positions[i]![0],
          y: g.positions[i]![1],
        }));
        nodes[0]!.gateway = true;
        const s = new MeshSimulator(
          { seed: g.seed, nodes, range: g.range, loss: g.loss, latency: [1, g.latencyMax], duplicateRate: g.dup },
          k.teamKey,
          k.serverPriv,
          k.serverPub,
        );
        const links = s.links();
        const gw = new Set(['n00']);
        const ids: { node: string; id: string; reachable: boolean }[] = [];
        for (let i = 0; i < g.n; i++) {
          if (!g.originMask[i]) continue;
          const node = nodes[i]!.id;
          const id = `01890000-0000-7000-8000-${(g.seed * 16 + i).toString(16).padStart(12, '0').slice(-12)}`;
          await s.node(node).originate('sos', sampleSos(id));
          ids.push({ node, id, reachable: connected(links, node, gw) });
        }
        const reachable = ids.filter((x) => x.reachable);
        coverage.runs++;
        coverage.delivered += reachable.length;
        coverage.unreachable += ids.length - reachable.length;
        coverage.multiHop += reachable.filter(
          (x) => x.node !== 'n00' && !links.some((l) => (l.a === 'n00' && l.b === x.node) || (l.b === 'n00' && l.a === x.node)),
        ).length;
        await s.run(400, () => reachable.every((x) => s.node(x.node).isAcked(x.id)));

        // eventual delivery + ack back to origin
        for (const x of reachable) {
          expect(s.server.records.has(x.id)).toBe(true);
          expect(s.node(x.node).isAcked(x.id)).toBe(true);
        }
        // no delivery without a path (honesty)
        for (const x of ids.filter((y) => !y.reachable)) expect(s.server.records.has(x.id)).toBe(false);
        // no duplicate delivery
        for (const m of s.deliveries.values()) for (const c of m.values()) expect(c).toBe(1);
        // no infinite forwarding
        await s.run(s.tick + 20);
        const tx = s.transmissions;
        await s.run(s.tick + 20);
        expect(s.transmissions).toBe(tx);
      }),
      { numRuns: 100, seed: 20260701 },
    );
    // Guard against a vacuous property: the generator must really exercise multi-hop and no-path cases.
    console.log('relay property coverage', coverage);
    expect(coverage.delivered).toBeGreaterThan(100);
    expect(coverage.multiHop).toBeGreaterThan(20);
    expect(coverage.unreachable).toBeGreaterThan(5);
  });
});
