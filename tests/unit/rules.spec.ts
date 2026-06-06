import { describe, it, expect } from 'vitest';
import {
  getSnakeOrder,
  getManagerForPick,
  canMakePick,
  validateLineup,
  validateTransfer,
  computeScore,
} from '../../src/lib/rules';

describe('Snake Order Logic', () => {
  it('generates correct pick order for 15 rounds (1→10 then 10→1)', () => {
    const order = getSnakeOrder(15);
    expect(order).toHaveLength(150); // 15 rounds × 10 managers
    
    // Round 1: slots 1-10 in ascending order
    expect(order.slice(0, 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    
    // Round 2: slots 10-1 in descending order
    expect(order.slice(10, 20)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    
    // Round 3: back to ascending
    expect(order.slice(20, 30)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('round 3 = 1→10, round 4 = 10→1', () => {
    const order = getSnakeOrder(15);
    expect(order.slice(20, 30)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); // round 3
    expect(order.slice(30, 40)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]); // round 4
  });
});

describe('getManagerForPick', () => {
  it('pick 1 → manager 1, pick 10 → manager 10', () => {
    expect(getManagerForPick(1)).toBe(1);
    expect(getManagerForPick(10)).toBe(10);
  });
  it('pick 11 (round 2) → manager 10', () => {
    expect(getManagerForPick(11)).toBe(10);
  });
  it('pick 20 (round 2 last) → manager 1', () => {
    expect(getManagerForPick(20)).toBe(1);
  });
  it('pick 21 (round 3) → manager 1', () => {
    expect(getManagerForPick(21)).toBe(1);
  });
});

describe('canMakePick — quota enforcement', () => {
  it('allows first DEF pick', () => {
    const roster = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
    const quota = { GK: 2, DEF: 5, MID: 5, FWD: 3 };
    expect(canMakePick('DEF', roster, quota)).toBe(true);
  });

  it('rejects 6th DEF', () => {
    const roster = { GK: 0, DEF: 5, MID: 0, FWD: 0 };
    const quota = { GK: 2, DEF: 5, MID: 5, FWD: 3 };
    expect(canMakePick('DEF', roster, quota)).toBe(false);
  });

  it('rejects pick that makes remaining quota unfillable', () => {
    // After picking 5 DEF, can't pick a MID if it means you can't fill quota
    const roster = { GK: 0, DEF: 4, MID: 5, FWD: 2 }; // 5 slots left, 2 GK needed, 0 DEF, 3 MID, 3 FWD — impossible
    const quota = { GK: 2, DEF: 5, MID: 5, FWD: 3 };
    expect(canMakePick('MID', roster, quota)).toBe(false);
  });

  it('allows when all quotas still fillable', () => {
    const roster = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
    const quota = { GK: 2, DEF: 5, MID: 5, FWD: 3 };
    expect(canMakePick('GK', roster, quota)).toBe(true);
  });

  it('allows FWD pick when FWD quota not exceeded', () => {
    const roster = { GK: 2, DEF: 5, MID: 5, FWD: 0 };
    const quota = { GK: 2, DEF: 5, MID: 5, FWD: 3 };
    expect(canMakePick('FWD', roster, quota)).toBe(true);
  });
});

describe('validateLineup — formation rules', () => {
  const roster = {
    GK: [1, 2],
    DEF: [3, 4, 5, 6, 7],
    MID: [8, 9, 10, 11, 12],
    FWD: [13, 14, 15],
  };

  it('accepts valid XI (1GK, 4DEF, 4MID, 2FWD)', () => {
    const xi = [1, 3, 4, 5, 6, 8, 9, 10, 11, 13, 14]; // 1 GK, 4 DEF, 4 MID, 2 FWD
    expect(validateLineup(xi, roster)).toBeNull(); // null = valid
  });

  it('rejects < 1 GK', () => {
    const xi = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14]; // no GK
    expect(validateLineup(xi, roster)).toContain('GK');
  });

  it('rejects < 3 DEF', () => {
    const xi = [1, 3, 4, 8, 9, 10, 11, 13, 14, 15, 12]; // only 2 DEF
    expect(validateLineup(xi, roster)).toContain('DEF');
  });

  it('rejects < 2 MID', () => {
    const xi = [1, 3, 4, 5, 6, 8, 9, 13, 14, 15, 12]; // only 1 MID
    expect(validateLineup(xi, roster)).toContain('MID');
  });

  it('rejects < 1 FWD', () => {
    const xi = [1, 3, 4, 5, 6, 8, 9, 10, 11, 12, 2]; // no FWD
    expect(validateLineup(xi, roster)).toContain('FWD');
  });

  it('rejects player not in roster', () => {
    const xi = [99, 3, 4, 5, 6, 8, 9, 10, 11, 13, 14]; // 99 not in roster
    expect(validateLineup(xi, roster)).toContain('not in roster');
  });

  it('rejects XI not totalling 11 players', () => {
    const xi = [1, 3, 4, 5, 6, 8, 9, 10, 11, 13]; // 10 players
    expect(validateLineup(xi, roster)).toContain('11 players');
  });
});

describe('validateTransfer', () => {
  const rosters = {
    manager1: { GK: [1, 2], DEF: [3, 4, 5, 6, 7], MID: [8, 9, 10, 11, 12], FWD: [13, 14, 15] },
    manager2: { GK: [16, 17], DEF: [18, 19, 20, 21, 22], MID: [23, 24, 25, 26, 27], FWD: [28, 29, 30] },
  };
  const quotas = { GK: 2, DEF: 5, MID: 5, FWD: 3 };

  it('accepts valid transfer: out DEF, in free-agent DEF', () => {
    const freeAgents = [31, 32, 33]; // DEF free agents
    expect(validateTransfer(1, 3, 31, rosters, quotas, freeAgents)).toBeNull();
  });

  it('rejects transfer of player not owned', () => {
    const freeAgents = [31];
    expect(validateTransfer(1, 99, 31, rosters, quotas, freeAgents)).toContain('not in your roster');
  });

  it('rejects transfer of non-free-agent player', () => {
    // Player 18 owned by manager2 — try to bring in as manager1
    expect(validateTransfer(1, 3, 18, rosters, quotas, [])).toContain('not a free agent');
  });

  it('rejects transfer that breaks quota', () => {
    // Manager1 already has 5 DEF, tries to bring in another DEF
    const roster1 = { GK: [1, 2], DEF: [3, 4, 5, 6, 7], MID: [8, 9, 10, 11, 12], FWD: [13, 14, 15] };
    const freeAgents = [31]; // another DEF
    expect(validateTransfer(1, 3, 31, { manager1: roster1, ...rosters }, quotas, freeAgents))
      .toContain('DEF quota');
  });
});

describe('computeScore', () => {
  const scoringTable = {
    appearance: 2,
    goal: { GK: 6, DEF: 5, MID: 4, FWD: 3 },
    assist: 3,
    cleanSheet: { GK: 5, DEF: 4, MID: 2 },
    save: 1,
    yellowCard: -1,
    redCard: -3,
    penaltyMissed: -2,
    knockoutMultiplier: 1.5,
  };

  it('player scores 5pts for 90-min appearance', () => {
    const result = computeScore({ appearance: true, minutes: 90 }, 'MID', scoringTable, false);
    expect(result.points).toBe(2);
  });

  it('MID scores 7pts: 1 goal (4) + 1 assist (3)', () => {
    const result = computeScore({ goal: 1, assist: 1 }, 'MID', scoringTable, false);
    expect(result.points).toBe(7);
  });

  it('GK scores for clean sheet: goal (6) + clean sheet (5) + appearance (2) = 13', () => {
    const result = computeScore({ goal: 1, cleanSheet: true, appearance: true }, 'GK', scoringTable, false);
    expect(result.points).toBe(13);
  });

  it('yellow card deducts 1pt', () => {
    const result = computeScore({ yellowCard: 1 }, 'MID', scoringTable, false);
    expect(result.points).toBe(-1);
  });

  it('knockout round multiplies by 1.5', () => {
    const result = computeScore({ goal: 1, assist: 1 }, 'MID', scoringTable, true); // knockout=true
    expect(result.points).toBe(10); // (4+3)*1.5
  });

  it('substitute not in XI gets 0 even if goals scored', () => {
    const result = computeScore({ goal: 2 }, 'FWD', scoringTable, false, { inStartingXI: false });
    expect(result.points).toBe(0);
  });

  it('breakdown JSON contains all event types', () => {
    const result = computeScore({ goal: 1, assist: 1, yellowCard: 1 }, 'MID', scoringTable, false);
    expect(result.breakdown).toEqual({
      goal: { count: 1, pts: 4 },
      assist: { count: 1, pts: 3 },
      yellowCard: { count: 1, pts: -1 },
      total: 6,
    });
  });
});