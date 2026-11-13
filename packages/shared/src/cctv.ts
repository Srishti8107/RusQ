/**
 * CCTV DEMO – SAMPLE DATA ONLY (§2.3, §10.5).
 *
 * There is no live camera network and no real footage. Each sample camera has
 * a short SYNTHETIC clip (a scene description the web app animates on a canvas:
 * road, water level, simple figure icons with no faces, a blockage) plus
 * PRE-LABELLED detections – written by hand, not produced by any model.
 * The labelled detections feed the decision-support rules as one more input.
 */

export const CCTV_LABELS = ['flooded_road', 'crowd', 'blockage'] as const;
export type CctvLabel = (typeof CCTV_LABELS)[number];
export const CCTV_LABEL_TEXT: Record<CctvLabel, string> = { flooded_road: 'Flooded road', crowd: 'Crowd', blockage: 'Road blockage' };

/** A hand-labelled detection active from t0 to t1 seconds; box in 0..1 frame coordinates. */
export interface CctvDetection {
  t0: number;
  t1: number;
  label: CctvLabel;
  confidence: number;
  box: [number, number, number, number];
  count?: number;
}

export interface CctvScene {
  /** water level keyframes (0 = dry road, 1 = water up to the horizon line) */
  water: { t: number; level: number }[];
  /** groups of simple figure icons, positions in 0..1, appear at `from` seconds */
  people: { x: number; y: number; n: number; from: number }[];
  blockage?: { x: number; y: number; w: number; h: number; kind: 'tree' | 'debris' | 'vehicle'; from: number };
  buildings: { x: number; w: number; h: number }[];
}

export interface CctvCamera {
  id: string;
  name: string;
  lat: number;
  lng: number;
  sample: true;
  clip: { durationS: number; scene: CctvScene; detections: CctvDetection[] };
}

export const SAMPLE_CCTV: CctvCamera[] = [
  {
    id: 'CAM-01',
    name: 'Zoo Road junction (sample)',
    lat: 27.6941,
    lng: 85.3212,
    sample: true,
    clip: {
      durationS: 24,
      scene: {
        water: [
          { t: 0, level: 0.15 },
          { t: 12, level: 0.35 },
          { t: 24, level: 0.45 },
        ],
        people: [
          { x: 0.72, y: 0.52, n: 9, from: 4 },
          { x: 0.2, y: 0.55, n: 4, from: 10 },
        ],
        blockage: { x: 0.42, y: 0.6, w: 0.18, h: 0.12, kind: 'tree', from: 6 },
        buildings: [
          { x: 0.02, w: 0.18, h: 0.35 },
          { x: 0.62, w: 0.3, h: 0.42 },
        ],
      },
      detections: [
        { t0: 0, t1: 24, label: 'flooded_road', confidence: 0.86, box: [0.0, 0.62, 1.0, 0.38] },
        { t0: 4, t1: 24, label: 'crowd', confidence: 0.78, box: [0.64, 0.4, 0.2, 0.2], count: 9 },
        { t0: 10, t1: 24, label: 'crowd', confidence: 0.61, box: [0.13, 0.45, 0.15, 0.17], count: 4 },
        { t0: 6, t1: 24, label: 'blockage', confidence: 0.9, box: [0.4, 0.55, 0.22, 0.17] },
      ],
    },
  },
  {
    id: 'CAM-02',
    name: 'Anil Nagar main lane (sample)',
    lat: 27.7018,
    lng: 85.3251,
    sample: true,
    clip: {
      durationS: 20,
      scene: {
        water: [
          { t: 0, level: 0.4 },
          { t: 20, level: 0.6 },
        ],
        people: [{ x: 0.5, y: 0.35, n: 14, from: 0 }],
        buildings: [
          { x: 0.05, w: 0.25, h: 0.55 },
          { x: 0.38, w: 0.26, h: 0.5 },
          { x: 0.7, w: 0.25, h: 0.45 },
        ],
      },
      detections: [
        { t0: 0, t1: 20, label: 'flooded_road', confidence: 0.93, box: [0.0, 0.5, 1.0, 0.5] },
        { t0: 0, t1: 20, label: 'crowd', confidence: 0.82, box: [0.4, 0.22, 0.22, 0.22], count: 14 },
      ],
    },
  },
  {
    id: 'CAM-03',
    name: 'Maligaon bridge approach (sample)',
    lat: 27.7156,
    lng: 85.2930,
    sample: true,
    clip: {
      durationS: 18,
      scene: {
        water: [{ t: 0, level: 0 }],
        people: [{ x: 0.3, y: 0.6, n: 2, from: 3 }],
        blockage: { x: 0.55, y: 0.58, w: 0.25, h: 0.14, kind: 'debris', from: 0 },
        buildings: [{ x: 0.75, w: 0.22, h: 0.3 }],
      },
      detections: [{ t0: 0, t1: 18, label: 'blockage', confidence: 0.74, box: [0.53, 0.53, 0.29, 0.2] }],
    },
  },
  {
    id: 'CAM-04',
    name: 'Sarusajai stadium gate (sample)',
    lat: 27.7049,
    lng: 85.3153,
    sample: true,
    clip: {
      durationS: 22,
      scene: {
        water: [{ t: 0, level: 0.05 }],
        people: [
          { x: 0.35, y: 0.55, n: 18, from: 0 },
          { x: 0.65, y: 0.58, n: 12, from: 8 },
        ],
        buildings: [{ x: 0.1, w: 0.8, h: 0.3 }],
      },
      detections: [
        { t0: 0, t1: 22, label: 'crowd', confidence: 0.88, box: [0.22, 0.42, 0.28, 0.25], count: 18 },
        { t0: 8, t1: 22, label: 'crowd', confidence: 0.8, box: [0.55, 0.45, 0.22, 0.24], count: 12 },
      ],
    },
  },
];

/** Detections visible at time t (for the player overlay). */
export function detectionsAt(cam: CctvCamera, t: number): CctvDetection[] {
  return cam.clip.detections.filter((d) => t >= d.t0 && t <= d.t1);
}

export function waterLevelAt(scene: CctvScene, t: number): number {
  const k = scene.water;
  if (k.length === 0) return 0;
  if (t <= k[0]!.t) return k[0]!.level;
  for (let i = 1; i < k.length; i++) {
    if (t <= k[i]!.t) {
      const a = k[i - 1]!;
      const b = k[i]!;
      return a.level + ((b.level - a.level) * (t - a.t)) / (b.t - a.t);
    }
  }
  return k.at(-1)!.level;
}

/** Per-camera summary used as decision-support input (max confidence; crowd = max simultaneous count). */
export interface CctvSignal {
  cameraId: string;
  name: string;
  lat: number;
  lng: number;
  flooded: number;
  blockage: number;
  crowd: number;
  crowdConfidence: number;
  sample: true;
}

export function cctvSignals(cams: CctvCamera[]): CctvSignal[] {
  return cams.map((c) => {
    const ds = c.clip.detections;
    const max = (l: CctvLabel) => ds.filter((d) => d.label === l).reduce((m, d) => Math.max(m, d.confidence), 0);
    // crowd count at the end of the clip = the latest situation
    const end = c.clip.durationS;
    const crowds = ds.filter((d) => d.label === 'crowd' && d.t0 <= end && d.t1 >= end);
    return {
      cameraId: c.id,
      name: c.name,
      lat: c.lat,
      lng: c.lng,
      flooded: max('flooded_road'),
      blockage: max('blockage'),
      crowd: crowds.reduce((s, d) => s + (d.count ?? 0), 0),
      crowdConfidence: crowds.reduce((m, d) => Math.max(m, d.confidence), 0),
      sample: true,
    };
  });
}
