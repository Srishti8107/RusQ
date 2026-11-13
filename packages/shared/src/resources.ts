/**
 * Resource catalogue shared by every app.
 *
 * All quantities are integers in the resource's `unit`. Divisible resources
 * (water, food) are counted in small units (litres, packs) so the allocation
 * engine can stay in exact integer arithmetic. `indivisible` marks things that
 * can never be split (a boat, a kit, a vehicle) – the engine treats every
 * resource as integer anyway, the flag is kept for UI wording and validation.
 */
export const RESOURCE_KEYS = [
  'food_water',
  'medical_supplies',
  'first_aid_kits',
  'boats',
  'rescue_equipment',
  'clothing_blankets',
  'transportation',
  'other',
] as const;

export type ResourceKey = (typeof RESOURCE_KEYS)[number];

export interface ResourceInfo {
  key: ResourceKey;
  label: string;
  unit: string;
  indivisible: boolean;
}

export const RESOURCES: Record<ResourceKey, ResourceInfo> = {
  food_water: { key: 'food_water', label: 'Food and water', unit: 'packs', indivisible: false },
  medical_supplies: { key: 'medical_supplies', label: 'Medical supplies', unit: 'boxes', indivisible: false },
  first_aid_kits: { key: 'first_aid_kits', label: 'First-aid kits', unit: 'kits', indivisible: true },
  boats: { key: 'boats', label: 'Boats', unit: 'boats', indivisible: true },
  rescue_equipment: { key: 'rescue_equipment', label: 'Rescue equipment', unit: 'sets', indivisible: true },
  clothing_blankets: { key: 'clothing_blankets', label: 'Clothing and blankets', unit: 'bundles', indivisible: false },
  transportation: { key: 'transportation', label: 'Transportation', unit: 'vehicles', indivisible: true },
  other: { key: 'other', label: 'Other', unit: 'units', indivisible: false },
};

export type ResourceQty = Partial<Record<ResourceKey, number>>;

/** Hazard labels used by on-device vision (fixed zero-shot prompts, §8C). */
export const HAZARD_LABELS = [
  'flooded street',
  'collapsed building',
  'blocked road',
  'fire or smoke',
  'landslide debris',
  'damaged bridge',
  'people waiting for rescue',
  'normal street',
] as const;
export type HazardLabel = (typeof HAZARD_LABELS)[number];

/**
 * Hazard → resource HINTS (§8B). Suggestions only: the UI shows them next to
 * the checklist but never ticks a box automatically. "life jackets" has no
 * own checklist row, so it maps to rescue equipment with a note.
 */
export const HAZARD_RESOURCE_HINTS: Record<HazardLabel, { resource: ResourceKey; note: string }[]> = {
  'flooded street': [
    { resource: 'boats', note: 'Boats' },
    { resource: 'rescue_equipment', note: 'Life jackets' },
    { resource: 'food_water', note: 'Drinking water' },
  ],
  'collapsed building': [
    { resource: 'rescue_equipment', note: 'Rescue equipment' },
    { resource: 'medical_supplies', note: 'Medical supplies' },
  ],
  'people waiting for rescue': [
    { resource: 'food_water', note: 'Food' },
    { resource: 'clothing_blankets', note: 'Blankets' },
    { resource: 'transportation', note: 'Transportation' },
  ],
  'blocked road': [{ resource: 'rescue_equipment', note: 'Clearing equipment' }],
  'fire or smoke': [{ resource: 'medical_supplies', note: 'Burn and smoke care' }],
  'landslide debris': [
    { resource: 'rescue_equipment', note: 'Rescue equipment' },
    { resource: 'medical_supplies', note: 'Medical supplies' },
  ],
  'damaged bridge': [{ resource: 'transportation', note: 'Alternate transport' }],
  'normal street': [],
};
