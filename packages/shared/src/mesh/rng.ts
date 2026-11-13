/** mulberry32 – tiny, fast, seeded PRNG so simulations are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic UUID-shaped ids from a seeded RNG (simulation only). */
export function seededUuid(rng: () => number): () => string {
  return () => {
    const h: string[] = [];
    for (let i = 0; i < 16; i++) h.push(Math.floor(rng() * 256).toString(16).padStart(2, '0'));
    h[6] = '7' + h[6]!.slice(1);
    h[8] = ((parseInt(h[8]!, 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
    const s = h.join('');
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  };
}
