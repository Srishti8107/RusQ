/**
 * Suggested amounts from the number of people, using Indian government relief norms.
 * The rescuer ticks what is needed; the app fills the amount; the rescuer can change it.
 * Integer arithmetic only, so every phone and the server get exactly the same numbers.
 *
 * Sources (all published by Indian government bodies):
 *  [KSDMA]  Kerala State Minimum Standards of Relief, Kerala SDMA, Ed. 1, July 2020, issued under
 *           Section 19 of the DM Act 2005 (states must not go below the NDMA minimum standards):
 *           meals thrice daily; 2,400 kcal/day for adults, 1,700 kcal/day for children;
 *           clothes incl. undergarments 2 pairs per person, towel 1 per person.
 *  [NDMA-S] National Guidelines on Temporary Shelters for Disaster-Affected Families, NDMA, Sept 2019:
 *           at least 3 litres of drinking water per person per day (plus 15 L for toilet and bathing).
 *  [NDMA-B] National Disaster Management Guidelines – Boat Safety, NDMA, Sept 2017: life jackets
 *           for all passengers and crew outside calm water (§3.5.7.2); boats carry at most 2/3 of their
 *           registered capacity in floods or high currents; a first-aid box in every boat (§3.4.1.3).
 *  [NDRF]   NDRF specification for the 4.5 m inflatable rescue boat (40 HP outboard): carrying
 *           capacity 10 persons.
 *
 * Not from a norm (stated as such in the app): 2 crew per boat (operator + rescuer), and one
 * first-aid kit for the site itself (the camp checklist in [KSDMA] lists a first-aid kit).
 * Medical supplies, vehicles and "other" have no per-person government rate: the rescuer enters them.
 */
import type { ResourceKey, ResourceQty } from './resources.ts';

export const RELIEF_RATES_ID = 'IN-NDMA-2017-2019+KSDMA-2020';

export interface ReliefRates {
  mealsPerPersonPerDay: number;
  drinkingWaterLitresPerPersonPerDay: number;
  clothingBundlesPerPerson: number;
  lifeJacketsPerPerson: number;
  boatCapacityPersons: number;
  /** flood load limit as a fraction (2/3) */
  floodLoadNum: number;
  floodLoadDen: number;
  boatCrew: number;
  firstAidKitsPerBoat: number;
  firstAidKitsPerSite: number;
}

export const INDIA_RELIEF_RATES: ReliefRates = {
  mealsPerPersonPerDay: 3,
  drinkingWaterLitresPerPersonPerDay: 3,
  clothingBundlesPerPerson: 1,
  lifeJacketsPerPerson: 1,
  boatCapacityPersons: 10,
  floodLoadNum: 2,
  floodLoadDen: 3,
  boatCrew: 2,
  firstAidKitsPerBoat: 1,
  firstAidKitsPerSite: 1,
};

export interface RateLine {
  key: ResourceKey;
  qty: number;
  /** how the number was worked out, in plain words */
  why: string;
  source: string;
}

export interface ReliefSuggestion {
  /** only resources that have a government rate */
  lines: Partial<Record<ResourceKey, RateLine>>;
  /** drinking water to go with the food packs (the app counts food and water together) */
  drinkingWaterLitres: number;
  /** people one boat can take per trip in a flood (after the 2/3 limit and the crew) */
  boatSeats: number;
}

const ceilDiv = (a: number, b: number) => Math.floor((a + b - 1) / b);

/**
 * @param people  people who need help (from the rescuer, or the photo estimate the rescuer confirmed)
 * @param days    days of supply to ask for (≥ 1)
 * @param boatsAsked boats the rescuer is asking for (0 = none); each boat also needs a first-aid box
 */
export function suggestRelief(people: number, days: number, boatsAsked: number, r: ReliefRates = INDIA_RELIEF_RATES): ReliefSuggestion {
  const p = Math.max(0, Math.floor(people));
  const d = Math.max(1, Math.floor(days));
  const boatSeats = Math.max(1, Math.floor((r.boatCapacityPersons * r.floodLoadNum) / r.floodLoadDen) - r.boatCrew);
  const boats = p === 0 ? 0 : ceilDiv(p, boatSeats);
  const lines: ReliefSuggestion['lines'] = {};
  const dayWord = `${d} day${d === 1 ? '' : 's'}`;
  if (p > 0) {
    lines.food_water = {
      key: 'food_water',
      qty: p * r.mealsPerPersonPerDay * d,
      why: `${p} people × ${r.mealsPerPersonPerDay} meals × ${dayWord} (one pack = one meal)`,
      source: 'Kerala SDMA Minimum Standards of Relief 2020: meals three times a day, 2,400 kcal adults / 1,700 kcal children',
    };
    lines.clothing_blankets = {
      key: 'clothing_blankets',
      qty: p * r.clothingBundlesPerPerson,
      why: `${p} people × ${r.clothingBundlesPerPerson} bundle (2 pairs of clothes + towel each)`,
      source: 'Kerala SDMA Minimum Standards of Relief 2020: clothes 2 pairs and a towel per person',
    };
    lines.rescue_equipment = {
      key: 'rescue_equipment',
      qty: p * r.lifeJacketsPerPerson,
      why: `${p} people × ${r.lifeJacketsPerPerson} life jacket`,
      source: 'NDMA Boat Safety Guidelines 2017 §3.5.7.2: life jackets for all passengers outside calm water',
    };
    lines.boats = {
      key: 'boats',
      qty: boats,
      why: `${p} people ÷ ${boatSeats} per boat, rounded up (10-person boat × 2/3 in floods = ${Math.floor((r.boatCapacityPersons * r.floodLoadNum) / r.floodLoadDen)}, minus ${r.boatCrew} crew) – for one trip`,
      source: 'NDMA Boat Safety Guidelines 2017: max 2/3 of capacity in floods; NDRF 4.5 m rescue boat: 10 persons. Crew of 2 is an assumption',
    };
  }
  const nb = Math.max(0, Math.floor(boatsAsked));
  const kits = nb * r.firstAidKitsPerBoat + r.firstAidKitsPerSite;
  lines.first_aid_kits = {
    key: 'first_aid_kits',
    qty: kits,
    why: nb > 0 ? `${nb} boat${nb === 1 ? '' : 's'} × ${r.firstAidKitsPerBoat} + ${r.firstAidKitsPerSite} for the site` : `${r.firstAidKitsPerSite} for the site`,
    source: 'NDMA Boat Safety Guidelines 2017 §3.4.1.3: a first-aid box in every boat; Kerala SDMA 2020 camp checklist: first-aid kit',
  };
  return { lines, drinkingWaterLitres: p * r.drinkingWaterLitresPerPersonPerDay * d, boatSeats };
}

/** Amounts for the ticked resources that have a rate; others are left as they are. */
export function applyRelief(ticked: readonly ResourceKey[], s: ReliefSuggestion): ResourceQty {
  const out: ResourceQty = {};
  for (const k of ticked) {
    const l = s.lines[k];
    if (l && l.qty > 0) out[k] = l.qty;
  }
  return out;
}
