/**
 * Small, DETERMINISTIC geography helpers (Phase 2 decision support, shelter
 * map, missing-person matching).
 *
 * Math.cos/Math.sin may differ in the last bit between JS engines, so ranking
 * code avoids them: distances use an equirectangular approximation whose
 * cosine is a fixed polynomial (only + and ×, which IEEE-754 makes identical
 * everywhere). Error < 0.5 % for the few-km distances used here.
 */

const KM_PER_DEG = 111.32;

/** cos(x) for |x| ≤ π/2 via an even Taylor polynomial up to x^10 (|err| < 5e-8). */
export function cosPoly(x: number): number {
  const x2 = x * x;
  return 1 - (x2 / 2) * (1 - (x2 / 12) * (1 - (x2 / 30) * (1 - (x2 / 56) * (1 - x2 / 90))));
}

/** Approximate distance in WHOLE metres (deterministic across engines). */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const midLat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dx = (b.lng - a.lng) * KM_PER_DEG * cosPoly(midLat);
  const dy = (b.lat - a.lat) * KM_PER_DEG;
  return Math.round(Math.sqrt(dx * dx + dy * dy) * 1000);
}

export function kmText(m: number): string {
  return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`;
}

/** Grid cell (≈1.1 km) used to group SOS / reports / CCTV into areas. Integer-based, so stable. */
export const CELL_DEG = 0.01;

export function cellOf(lat: number, lng: number): { id: string; lat: number; lng: number } {
  const i = Math.floor(lat * 100);
  const j = Math.floor(lng * 100);
  return { id: `c${i}_${j}`, lat: (i + 0.5) / 100, lng: (j + 0.5) / 100 };
}

/** Polygon ring of a cell (for map shading). */
export function cellPolygon(cellId: string): [number, number][] {
  const m = /^c(-?\d+)_(-?\d+)$/.exec(cellId);
  if (!m) return [];
  const [s, w] = [Number(m[1]) / 100, Number(m[2]) / 100];
  const [n, e] = [s + CELL_DEG, w + CELL_DEG];
  return [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
    [w, s],
  ];
}

/** FNV-1a 32-bit → 8 hex chars. Deterministic content hash for ids. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
