import { describe, expect, it } from 'vitest';
import { applyRelief, INDIA_RELIEF_RATES, suggestRelief } from '../src/index.ts';

describe('Indian relief norms', () => {
  it('40 people, 1 day', () => {
    const s = suggestRelief(40, 1, 10);
    expect(s.boatSeats).toBe(4); // 10 × 2/3 = 6, minus 2 crew
    expect(s.lines.food_water!.qty).toBe(120);
    expect(s.drinkingWaterLitres).toBe(120);
    expect(s.lines.clothing_blankets!.qty).toBe(40);
    expect(s.lines.rescue_equipment!.qty).toBe(40);
    expect(s.lines.boats!.qty).toBe(10);
    expect(s.lines.first_aid_kits!.qty).toBe(11);
    expect(s.lines.medical_supplies).toBeUndefined();
    expect(s.lines.transportation).toBeUndefined();
  });

  it('days multiply food and water only; boats round up; no boats → 1 first-aid kit', () => {
    const s = suggestRelief(7, 3, 0);
    expect(s.lines.food_water!.qty).toBe(63);
    expect(s.drinkingWaterLitres).toBe(63);
    expect(s.lines.clothing_blankets!.qty).toBe(7);
    expect(s.lines.boats!.qty).toBe(2);
    expect(s.lines.first_aid_kits!.qty).toBe(1);
  });

  it('0 people suggests nothing except the site first-aid kit; bad input is clamped', () => {
    expect(Object.keys(suggestRelief(0, 1, 2).lines)).toEqual(['first_aid_kits']);
    expect(suggestRelief(5, 0, 0).lines.food_water!.qty).toBe(15);
  });

  it('applies only to ticked resources that have a rate', () => {
    const s = suggestRelief(10, 1, 3);
    expect(applyRelief(['food_water', 'medical_supplies', 'boats'], s)).toEqual({ food_water: 30, boats: 3 });
  });

  it('every line says how it was worked out and cites a source', () => {
    for (const l of Object.values(suggestRelief(12, 2, 3).lines)) {
      expect(l!.why.length).toBeGreaterThan(5);
      expect(l!.source).toMatch(/NDMA|SDMA|NDRF/);
    }
    expect(INDIA_RELIEF_RATES.boatCapacityPersons).toBe(10);
  });
});
