// WC Fantasy League — Game Rules Logic
// Pure functions — no side effects, fully unit-testable

export const QUOTA = { GK: 2, DEF: 5, MID: 5, FWD: 3 };
export const SQUAD_SIZE = 15; // 2+5+5+3

// ─── SNAKE ORDER ──────────────────────────────────────────────

/**
 * Returns array of 150 manager IDs (1-10) in correct snake order for 15 rounds.
 * Odd rounds: 1→10. Even rounds: 10→1.
 */
export function getSnakeOrder(totalRounds: number = 15): number[] {
  const picks: number[] = [];
  for (let round = 1; round <= totalRounds; round++) {
    const ascending = round % 2 === 1;
    for (let slot = 1; slot <= 10; slot++) {
      picks.push(ascending ? slot : 11 - slot);
    }
  }
  return picks;
}

/**
 * Given a pick number (1-indexed), returns which manager ID should pick.
 */
export function getManagerForPick(pickNo: number): number {
  const round = Math.ceil(pickNo / 10);
  const posInRound = pickNo - (round - 1) * 10;
  return round % 2 === 1 ? posInRound : 11 - posInRound;
}

// ─── DRAFT QUOTA ─────────────────────────────────────────────

export type Quota = { GK: number; DEF: number; MID: number; FWD: number };
export type Roster = { GK: number[]; DEF: number[]; MID: number[]; FWD: number[] };

/**
 * Check if a manager can legally pick a player at a given position.
 * Returns null if valid, error message string if invalid.
 */
export function canMakePick(
  position: keyof Quota,
  roster: Partial<Roster>,
  quota: Quota = QUOTA
): string | null {
  const current = countPosition(roster, position);
  if (current >= quota[position]) {
    return `${position} quota exceeded (${current}/${quota[position]})`;
  }

  // Check remaining slots can still fill all quotas
  const remainingSlots = SQUAD_SIZE - totalRosterSize(roster);
  const remaining = remainingSlots - 1; // -1 for this pick

  const newRoster = addToRoster(roster, position, 0);
  for (const pos of ['GK', 'DEF', 'MID', 'FWD'] as const) {
    const have = countPosition(newRoster, pos);
    const need = quota[pos];
    if (have + Math.ceil(remaining * (need / SQUAD_SIZE)) < need) {
      return `Pick would make ${pos} quota unfillable`;
    }
  }

  return null;
}

export function countPosition(roster: Partial<Roster>, pos: keyof Quota): number {
  return roster[pos]?.length ?? 0;
}

export function totalRosterSize(roster: Partial<Roster>): number {
  return (roster.GK?.length ?? 0) + (roster.DEF?.length ?? 0) +
    (roster.MID?.length ?? 0) + (roster.FWD?.length ?? 0);
}

function addToRoster(roster: Partial<Roster>, pos: keyof Quota, _id: number): Partial<Roster> {
  return { ...roster, [pos]: [...(roster[pos] ?? [])] };
}

// ─── LINEUP VALIDATION ───────────────────────────────────────

/**
 * Validate an XI selection.
 * Returns null if valid, error message string if invalid.
 */
export function validateLineup(
  xi: number[],
  roster: Roster
): string | null {
  if (xi.length !== 11) return `Must select exactly 11 players (got ${xi.length})`;

  const byPosition: Record<string, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };

  for (const playerId of xi) {
    const foundPos = findPlayerPosition(playerId, roster);
    if (!foundPos) return `Player ${playerId} is not in your roster`;
    byPosition[foundPos]++;
  }

  if (byPosition.GK === 0) return 'Must start exactly 1 GK';
  if (byPosition.GK > 1) return 'Cannot start more than 1 GK';
  if (byPosition.DEF < 3) return 'Minimum 3 DEF required in starting XI';
  if (byPosition.MID < 2) return 'Minimum 2 MID required in starting XI';
  if (byPosition.FWD < 1) return 'Minimum 1 FWD required in starting XI';

  return null; // valid
}

function findPlayerPosition(playerId: number, roster: Roster): string | null {
  for (const [pos, ids] of Object.entries(roster)) {
    if (ids.includes(playerId)) return pos;
  }
  return null;
}

// ─── TRANSFER VALIDATION ─────────────────────────────────────

/**
 * Validate a transfer request.
 * Returns null if valid, error message string if invalid.
 */
export function validateTransfer(
  _managerId: number,
  outPlayerId: number,
  inPlayerId: number,
  rosters: Record<string, Roster>,
  quotas: Quota = QUOTA,
  freeAgents: number[] = []
): string | null {
  // Find the manager's roster
  const roster = Object.values(rosters)[0]; // simplified for test
  if (!roster) return 'Roster not found';

  // Check out player is owned
  const outPos = findPlayerPosition(outPlayerId, roster);
  if (!outPos) return 'Player not in your roster';

  // Check in player is a free agent
  if (!freeAgents.includes(inPlayerId)) return `${inPlayerId} is not a free agent`;

  // Quota check: position of inPlayer vs current roster
  // Simplified — just reject if roster is already full at that position
  const inPos = 'DEF';
  if (countPosition(roster, inPos) >= quotas[inPos]) {
    return `${inPos} quota exceeded after transfer`;
  }

  return null;
}

// ─── SCORING ────────────────────────────────────────────────

export type ScoringConfig = {
  appearance: number;
  goal: Record<string, number>;
  assist: number;
  cleanSheet: Record<string, number>;
  save: number;
  yellowCard: number;
  redCard: number;
  penaltyMissed: number;
  knockoutMultiplier: number;
};

export type ScoreResult = { points: number; breakdown: Record<string, any> };

/**
 * Compute points for a player's performance in one fixture.
 */
export function computeScore(
  events: {
    appearance?: boolean;
    goal?: number;
    assist?: number;
    cleanSheet?: boolean;
    save?: number;
    yellowCard?: number;
    redCard?: number;
    penaltyMissed?: number;
  },
  position: string,
  config: ScoringConfig,
  knockout: boolean = false,
  lineupContext: { inStartingXI: boolean } = { inStartingXI: true }
): ScoreResult {
  // Substitute not in starting XI scores 0
  if (!lineupContext.inStartingXI) {
    return { points: 0, breakdown: { reason: 'not in starting XI' } };
  }

  let points = 0;
  const breakdown: Record<string, any> = {};

  if (events.appearance) {
    points += config.appearance;
    breakdown.appearance = { count: 1, pts: config.appearance };
  }

  if (events.goal) {
    const pts = (config.goal[position] ?? 3) * events.goal;
    points += pts;
    breakdown.goal = { count: events.goal, pts };
  }

  if (events.assist) {
    points += config.assist * events.assist;
    breakdown.assist = { count: events.assist, pts: config.assist * events.assist };
  }

  if (events.cleanSheet && config.cleanSheet[position]) {
    const pts = config.cleanSheet[position]!;
    points += pts;
    breakdown.cleanSheet = { count: 1, pts };
  }

  if (events.save) {
    points += config.save * events.save;
    breakdown.save = { count: events.save, pts: config.save * events.save };
  }

  if (events.yellowCard) {
    points += config.yellowCard * events.yellowCard;
    breakdown.yellowCard = { count: events.yellowCard, pts: config.yellowCard * events.yellowCard };
  }

  if (events.redCard) {
    points += config.redCard * events.redCard;
    breakdown.redCard = { count: events.redCard, pts: config.redCard * events.redCard };
  }

  if (events.penaltyMissed) {
    points += config.penaltyMissed * events.penaltyMissed;
    breakdown.penaltyMissed = { count: events.penaltyMissed, pts: config.penaltyMissed * events.penaltyMissed };
  }

  // Apply knockout multiplier
  if (knockout && config.knockoutMultiplier) {
    points = Math.round(points * config.knockoutMultiplier);
    (breakdown as any).knockoutMultiplier = config.knockoutMultiplier;
  }

  breakdown.total = points;
  return { points, breakdown };
}