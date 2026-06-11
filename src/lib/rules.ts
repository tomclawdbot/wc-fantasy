// Pure game-rules functions, fully config-driven. Used for client-side
// pre-validation and display ONLY — the database functions are the
// authority. There is deliberately no scoring math here: scoring lives
// in one place, score_event_points() in Postgres.

import type { LeagueConfig, Position } from '../config/types';

export type Roster = Partial<Record<Position, string[]>>;

// ─── Snake order ─────────────────────────────────────────────

/** Which draft slot picks at a given 1-indexed pick number. */
export function slotForPick(pickNo: number, numManagers: number): number {
  const round = Math.ceil(pickNo / numManagers);
  const posInRound = pickNo - (round - 1) * numManagers;
  return round % 2 === 1 ? posInRound : numManagers + 1 - posInRound;
}

/** Full snake order: squadSize rounds × numManagers picks. */
export function getSnakeOrder(numManagers: number, squadSize: number): number[] {
  const total = numManagers * squadSize;
  return Array.from({ length: total }, (_, i) => slotForPick(i + 1, numManagers));
}

export function totalPicks(numManagers: number, config: LeagueConfig): number {
  return numManagers * config.squad.size;
}

export function roundForPick(pickNo: number, numManagers: number): number {
  return Math.ceil(pickNo / numManagers);
}

// ─── Draft quota ─────────────────────────────────────────────

export function countPosition(roster: Roster, pos: Position): number {
  return roster[pos]?.length ?? 0;
}

export function totalRosterSize(roster: Roster): number {
  return (Object.values(roster) as string[][]).reduce((n, ids) => n + (ids?.length ?? 0), 0);
}

/** null = legal pick; string = reason it's illegal. Mirrors check_squad_quota in SQL. */
export function canMakePick(position: Position, roster: Roster, config: LeagueConfig): string | null {
  const { size, quota } = config.squad;
  const positions = Object.keys(quota) as Position[];

  if (totalRosterSize(roster) >= size) return `Squad full (${size} players)`;

  const have = countPosition(roster, position);
  if (have >= quota[position]) {
    return `${position} quota exceeded (${have}/${quota[position]})`;
  }

  // fillability: every quota must remain reachable after this pick
  const counts: Record<Position, number> = Object.fromEntries(
    positions.map(p => [p, countPosition(roster, p)])
  ) as Record<Position, number>;
  counts[position] += 1;
  const remaining = size - (totalRosterSize(roster) + 1);
  for (const pos of positions) {
    if (counts[pos] + remaining < quota[pos]) {
      return `Pick would make ${pos} quota unfillable`;
    }
  }
  return null;
}

// ─── Lineup validation ───────────────────────────────────────

export function validateLineup(
  xi: string[],
  roster: Roster,
  config: LeagueConfig
): string | null {
  const { size, min, max } = config.lineup;
  if (xi.length !== size) return `Must select exactly ${size} players (got ${xi.length})`;
  if (new Set(xi).size !== size) return 'Duplicate players in lineup';

  const counts: Partial<Record<Position, number>> = {};
  for (const playerId of xi) {
    const pos = findPlayerPosition(playerId, roster);
    if (!pos) return `Player ${playerId} is not in your roster`;
    counts[pos] = (counts[pos] ?? 0) + 1;
  }
  for (const pos of Object.keys(config.squad.quota) as Position[]) {
    const c = counts[pos] ?? 0;
    const lo = min[pos] ?? 0;
    const hi = max[pos] ?? size;
    if (c < lo) return `Need at least ${lo} ${pos}`;
    if (c > hi) return `Max ${hi} ${pos}`;
  }
  return null;
}

function findPlayerPosition(playerId: string, roster: Roster): Position | null {
  for (const [pos, ids] of Object.entries(roster)) {
    if (ids?.includes(playerId)) return pos as Position;
  }
  return null;
}

// ─── Transfer pre-check (display only; make_transfer is authoritative) ─

export function canTransferIn(
  inPosition: Position,
  outPosition: Position,
  roster: Roster,
  config: LeagueConfig
): string | null {
  if (inPosition === outPosition) return null;
  const have = countPosition(roster, inPosition);
  if (have >= config.squad.quota[inPosition]) {
    return `${inPosition} quota exceeded after transfer`;
  }
  return null;
}
