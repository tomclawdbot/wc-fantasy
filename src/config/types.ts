// LeagueConfig mirrors leagues.config JSONB — the single source of all
// tournament-specific rules. The DB is authoritative; the client only
// reads this for display and pre-validation.

export type Position = 'GK' | 'DEF' | 'MID' | 'FWD';

export interface PhaseConfig {
  key: string;          // matches matchdays.phase / fixtures.phase
  label: string;
  type: 'group' | 'knockout';
  multiplier: number;   // applied once, in rescore_fixture
}

export interface LeagueConfig {
  draft: { timer_seconds: number };
  squad: { size: number; quota: Record<Position, number> };
  lineup: {
    size: number;
    min: Partial<Record<Position, number>>;
    max: Partial<Record<Position, number>>;
  };
  scoring: {
    appearance: number;
    goal: Record<Position, number> | number;
    assist: number;
    clean_sheet: Partial<Record<Position, number>>;
    save: number;
    yellow_card: number;
    second_yellow: number;
    red_card: number;
    own_goal: number;
    penalty_missed: number;
    penalty_saved: number;
  };
  phases: PhaseConfig[];
  data_source: { provider: string; league_id: number; season: number };
}

export const FALLBACK_CONFIG: LeagueConfig = {
  draft: { timer_seconds: 60 },
  squad: { size: 15, quota: { GK: 2, DEF: 5, MID: 5, FWD: 3 } },
  lineup: { size: 11, min: { GK: 1, DEF: 3, MID: 2, FWD: 1 }, max: { GK: 1, DEF: 5, MID: 5, FWD: 3 } },
  scoring: {
    appearance: 2, goal: { GK: 8, DEF: 8, MID: 8, FWD: 8 }, assist: 4,
    clean_sheet: { GK: 4, DEF: 4, MID: 2, FWD: 0 }, save: 1,
    yellow_card: -1, second_yellow: -3, red_card: -3,
    own_goal: -4, penalty_missed: -2, penalty_saved: 4,
  },
  phases: [],
  data_source: { provider: 'api-football', league_id: 1, season: 2026 },
};
