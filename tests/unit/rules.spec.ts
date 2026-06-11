import { describe, it, expect } from 'vitest';
import {
  slotForPick, getSnakeOrder, totalPicks, roundForPick,
  canMakePick, validateLineup, canTransferIn, type Roster,
} from '../../src/lib/rules';
import { FALLBACK_CONFIG } from '../../src/config/types';

const cfg = FALLBACK_CONFIG; // 15-squad 2/5/5/3, XI with GK=1, DEF>=3, MID>=2, FWD>=1

describe('snake order', () => {
  it('bounces at round boundaries (10 managers)', () => {
    expect(slotForPick(1, 10)).toBe(1);
    expect(slotForPick(10, 10)).toBe(10);
    expect(slotForPick(11, 10)).toBe(10); // the v1 wrap bug: was slot 9
    expect(slotForPick(12, 10)).toBe(9);
    expect(slotForPick(20, 10)).toBe(1);
    expect(slotForPick(21, 10)).toBe(1);
  });

  it('works for any manager count', () => {
    expect(slotForPick(9, 9)).toBe(9);
    expect(slotForPick(10, 9)).toBe(9);
    expect(slotForPick(11, 9)).toBe(8);
    expect(getSnakeOrder(9, 15)).toHaveLength(135);
    expect(getSnakeOrder(10, 15)).toHaveLength(150);
  });

  it('total picks and rounds derive from config', () => {
    expect(totalPicks(10, cfg)).toBe(150);
    expect(totalPicks(9, cfg)).toBe(135);
    expect(roundForPick(11, 10)).toBe(2);
    expect(roundForPick(135, 9)).toBe(15);
  });
});

describe('draft quota', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);

  it('rejects over-quota picks', () => {
    const roster: Roster = { GK: ids(2), DEF: [], MID: [], FWD: [] };
    expect(canMakePick('GK', roster, cfg)).toMatch(/quota exceeded/);
  });

  it('rejects picks that make another quota unfillable (flex quotas)', () => {
    // With 2-5-5-3 summing exactly to 15, fillability never binds; it exists
    // for configs where quotas sum past squad size (flex slots).
    const flex = { ...cfg, squad: { size: 5, quota: { GK: 1, DEF: 2, MID: 2, FWD: 2 } } };
    const roster: Roster = { GK: [], DEF: ids(2), MID: ids(2), FWD: [] };
    expect(canMakePick('FWD', roster, flex)).toMatch(/unfillable/); // last slot must be GK
    expect(canMakePick('GK', roster, flex)).toBeNull();
  });

  it('accepts a legal pick', () => {
    const roster: Roster = { GK: ids(1), DEF: ids(3), MID: ids(3), FWD: ids(1) };
    expect(canMakePick('DEF', roster, cfg)).toBeNull();
  });
});

describe('lineup validation', () => {
  const roster: Roster = {
    GK: ['gk1', 'gk2'],
    DEF: ['d1', 'd2', 'd3', 'd4', 'd5'],
    MID: ['m1', 'm2', 'm3', 'm4', 'm5'],
    FWD: ['f1', 'f2', 'f3'],
  };

  it('accepts a legal 4-4-2', () => {
    const xi = ['gk1', 'd1', 'd2', 'd3', 'd4', 'm1', 'm2', 'm3', 'm4', 'f1', 'f2'];
    expect(validateLineup(xi, roster, cfg)).toBeNull();
  });

  it('rejects wrong size, duplicates, two GKs, thin defence', () => {
    expect(validateLineup(['gk1'], roster, cfg)).toMatch(/exactly 11/);
    const dup = ['gk1', 'd1', 'd1', 'd2', 'd3', 'm1', 'm2', 'm3', 'm4', 'f1', 'f2'];
    expect(validateLineup(dup, roster, cfg)).toMatch(/Duplicate/);
    const twoGk = ['gk1', 'gk2', 'd1', 'd2', 'd3', 'm1', 'm2', 'm3', 'f1', 'f2', 'f3'];
    expect(validateLineup(twoGk, roster, cfg)).toMatch(/Max 1 GK/);
    const thin = ['gk1', 'd1', 'd2', 'm1', 'm2', 'm3', 'm4', 'm5', 'f1', 'f2', 'f3'];
    expect(validateLineup(thin, roster, cfg)).toMatch(/at least 3 DEF/);
  });

  it('rejects players outside the roster', () => {
    const xi = ['gk1', 'd1', 'd2', 'd3', 'd4', 'm1', 'm2', 'm3', 'm4', 'f1', 'stranger'];
    expect(validateLineup(xi, roster, cfg)).toMatch(/not in your roster/);
  });
});

describe('transfer pre-check', () => {
  it('same-position swaps always pass quota', () => {
    const roster: Roster = { GK: ['gk1', 'gk2'], DEF: [], MID: [], FWD: [] };
    expect(canTransferIn('GK', 'GK', roster, cfg)).toBeNull();
  });
  it('cross-position swap into a full position fails', () => {
    const roster: Roster = { GK: ['gk1', 'gk2'], DEF: [], MID: [], FWD: [] };
    expect(canTransferIn('GK', 'DEF', roster, cfg)).toMatch(/quota exceeded/);
  });
});
