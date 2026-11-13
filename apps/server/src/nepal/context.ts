/**
 * Real Nepal background data for the Kathmandu sample region (built by scripts/build-nepal-data.mjs
 * from WorldPop 2024, the Copernicus DEM, and OpenStreetMap rivers and health facilities – see
 * `sources` in the JSON) plus the official figures of the September 2024 floods (NDRRMA SitRep #4).
 *
 * Used for CONTEXT only: residents are an estimate of who lives in an area, flood-prone land is a
 * terrain model. Neither is a count of people needing help now.
 */
import { distanceM, type AreaContext } from '@rusq/shared';
import data from './kathmandu-context.json';

export interface Facility {
  id: string;
  name: string;
  kind: 'hospital' | 'clinic';
  lat: number;
  lng: number;
  emergency?: boolean;
  beds?: number;
  /** on HIGH flood-prone land (terrain model) */
  floodProne?: boolean;
}

interface NepalContextFile {
  region: { name: string; bounds: [number, number, number, number] };
  sources: Record<'residents' | 'terrain' | 'health', { title: string; url: string; license: string; caution: string }>;
  totals: { residents: number; residentsFloodProne: number; floodProneKm2: number; moderateKm2: number };
  cells: Record<string, AreaContext>;
  hospitals: Facility[];
  rivers: { type: 'FeatureCollection'; features: unknown[] };
  floodProneImage: { url: string; coordinates: [number, number][] };
}

const ctx = data as unknown as NepalContextFile;

/** Official figures – NDRRMA, "2024 September Floods and Landslides", Situation Report #4 (as of 16 Oct 2024). */
export const REFERENCE_EVENT_2024 = {
  title: '2024 September floods and landslides, Nepal',
  source: 'NDRRMA (Government of Nepal, Ministry of Home Affairs) – Situation Report #4, as of 16 October 2024',
  url: 'https://ndrrma.gov.np/mediafiles/publications/SitRep_4_-_2024_September_Floods_and_Landslides_English.pdf',
  deaths: 250,
  missing: 18,
  injured: 178,
  rescued: 'more than 17,000',
  emergencyMunicipalities: 71,
  emergencyDistricts: 20,
  kathmanduRainfall: 'Record 239.7 mm in 24 hours at Tribhuvan International Airport (previous record 177 mm, 2002)',
  bagmatiHouseholds: { fully: 4334, partially: 6593 },
  rainfallPeriod: '27–29 September 2024',
  caution: 'National totals combine floods AND landslides; later reports may revise them.',
} as const;

export function nepalContext() {
  return ctx;
}

/** Per-area context for decision support (only cells inside the sample region). */
export function areaContext(): Record<string, AreaContext> {
  return ctx.cells;
}

export function inRegion(p: { lat: number; lng: number }): boolean {
  const [w, s, e, n] = ctx.region.bounds;
  return p.lng >= w && p.lng <= e && p.lat >= s && p.lat <= n;
}

/** Nearest hospital (preferred) or clinic from OpenStreetMap, with straight-line distance. */
export function nearestFacility(p: { lat: number; lng: number }, kind: 'hospital' | 'any' = 'hospital'): (Facility & { distanceM: number }) | null {
  let best: (Facility & { distanceM: number }) | null = null;
  for (const f of ctx.hospitals) {
    if (kind === 'hospital' && f.kind !== 'hospital') continue;
    const d = distanceM(p, f);
    if (!best || d < best.distanceM) best = { ...f, distanceM: d };
  }
  return best;
}
