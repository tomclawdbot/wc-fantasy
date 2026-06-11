-- ════════════════════════════════════════════════════════════════
-- tournament-fantasy 0001_init
-- Tournament-agnostic schema. ALL tournament-specific values
-- (squad size, quotas, scoring, phases, timer) live in leagues.config.
-- No hardcoded league IDs, manager counts, or pick totals anywhere.
-- ════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ─── leagues ─────────────────────────────────────────────────────
CREATE TABLE leagues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  commissioner_id UUID,             -- FK added after managers exists
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── managers ────────────────────────────────────────────────────
CREATE TABLE managers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  league_id UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  team_name TEXT,
  email TEXT,
  draft_slot INTEGER CHECK (draft_slot >= 1),  -- upper bound enforced by config, not DDL
  is_commissioner BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX manager_league_user ON managers(league_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX manager_slot ON managers(league_id, draft_slot) WHERE draft_slot IS NOT NULL;

ALTER TABLE leagues ADD CONSTRAINT leagues_commissioner_id_fkey
  FOREIGN KEY (commissioner_id) REFERENCES managers(id) ON DELETE SET NULL;

-- ─── allowed_emails: invite list, enforced by claim_manager_slot ──
CREATE TABLE allowed_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (league_id, email)
);

-- ─── tournament_teams (was wc_nations) ───────────────────────────
CREATE TABLE tournament_teams (
  league_id UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  team TEXT NOT NULL,
  ext_team_id TEXT,
  flag_url TEXT,
  eliminated_at TIMESTAMPTZ,        -- set when knocked out; players score 0 after
  PRIMARY KEY (league_id, team)
);

-- ─── players ─────────────────────────────────────────────────────
CREATE TABLE players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ext_player_id TEXT UNIQUE,
  name TEXT NOT NULL,
  nation TEXT NOT NULL,
  club TEXT,
  club_name TEXT,
  position TEXT NOT NULL CHECK (position IN ('GK','DEF','MID','FWD')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','withdrawn')),
  ranking INTEGER,
  in_squad BOOLEAN NOT NULL DEFAULT false,   -- in official tournament squad
  photo_url TEXT,
  nation_flag_url TEXT,
  club_logo_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX players_position ON players(position);
CREATE INDEX players_nation ON players(nation);
CREATE INDEX players_status ON players(status);
CREATE INDEX players_name_trgm ON players USING gin (name gin_trgm_ops);

-- ─── draft ───────────────────────────────────────────────────────
CREATE TABLE draft_state (
  league_id UUID PRIMARY KEY REFERENCES leagues(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','in_progress','paused','complete')),
  current_pick_no INTEGER NOT NULL DEFAULT 0,
  current_manager_id UUID REFERENCES managers(id),
  round_no INTEGER NOT NULL DEFAULT 0,
  pick_deadline TIMESTAMPTZ,
  timer_seconds INTEGER NOT NULL DEFAULT 60
);

CREATE TABLE draft_picks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  pick_no INTEGER NOT NULL CHECK (pick_no >= 1),
  round_no INTEGER NOT NULL DEFAULT 0,
  manager_id UUID NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id),
  auto_pick BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (league_id, player_id),      -- race-safe: one owner per player
  UNIQUE (league_id, pick_no)
);
CREATE INDEX draft_picks_manager ON draft_picks(manager_id);

CREATE TABLE pick_queues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_id UUID NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id),
  rank INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (manager_id, player_id),
  UNIQUE (manager_id, rank)
);

-- ─── rosters ─────────────────────────────────────────────────────
CREATE TABLE rosters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_id UUID NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id),
  acquired_via TEXT NOT NULL CHECK (acquired_via IN ('draft','transfer','free_agent')),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (manager_id, player_id)
);
CREATE INDEX rosters_manager ON rosters(manager_id, active);

-- ─── schedule: matchdays + fixtures ──────────────────────────────
CREATE TABLE matchdays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,                -- must match a config.phases[].key
  label TEXT NOT NULL,
  lock_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (league_id, phase)
);

CREATE TABLE fixtures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  matchday_id UUID REFERENCES matchdays(id),   -- v2: fixture→matchday mapping (fixes group-stage triple counting)
  ext_fixture_id TEXT UNIQUE,
  phase TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  kickoff_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','in_progress','finished','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX fixtures_league ON fixtures(league_id, phase);
CREATE INDEX fixtures_matchday ON fixtures(matchday_id);

-- ─── lineups ─────────────────────────────────────────────────────
CREATE TABLE lineups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_id UUID NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
  matchday_id UUID NOT NULL REFERENCES matchdays(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id),
  slot INTEGER NOT NULL CHECK (slot >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (manager_id, matchday_id, player_id),
  UNIQUE (manager_id, matchday_id, slot)
);
CREATE INDEX lineups_matchday ON lineups(manager_id, matchday_id);

-- ─── transfers ───────────────────────────────────────────────────
CREATE TABLE transfer_windows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  opens_at TIMESTAMPTZ NOT NULL,
  closes_at TIMESTAMPTZ NOT NULL,
  free_count INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX transfer_windows_league ON transfer_windows(league_id);

CREATE TABLE transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_id UUID NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
  window_id UUID REFERENCES transfer_windows(id),
  out_player_id UUID NOT NULL REFERENCES players(id),
  in_player_id UUID NOT NULL REFERENCES players(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (manager_id, window_id, out_player_id)
);

-- ─── events + scoring ────────────────────────────────────────────
CREATE TABLE player_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  fixture_id UUID NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  ext_event_id TEXT,
  event_type TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,     -- e.g. saves count
  minute INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (fixture_id, player_id, event_type, ext_event_id)
);
CREATE INDEX player_events_player ON player_events(player_id);
CREATE INDEX player_events_fixture ON player_events(fixture_id);

CREATE TABLE match_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  fixture_id UUID NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  points INTEGER NOT NULL DEFAULT 0,  -- phase multiplier already applied; standings must NOT reapply
  breakdown JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (player_id, fixture_id)
);
CREATE INDEX match_scores_fixture ON match_scores(fixture_id);

CREATE TABLE standings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_id UUID UNIQUE NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
  total_points INTEGER NOT NULL DEFAULT 0,
  by_phase JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── watchlist ───────────────────────────────────────────────────
CREATE TABLE player_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_id UUID NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  watched BOOLEAN NOT NULL DEFAULT false,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (manager_id, player_id)
);

-- ─── updated_at triggers ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['leagues','managers','players','draft_picks','rosters',
    'matchdays','fixtures','lineups','transfer_windows','transfers',
    'player_events','match_scores','player_notes']
  LOOP
    EXECUTE format('CREATE TRIGGER t_updated_at_%I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION updated_at()', t, t);
  END LOOP;
END $$;

-- ─── realtime ────────────────────────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE draft_state;
ALTER PUBLICATION supabase_realtime ADD TABLE draft_picks;
ALTER PUBLICATION supabase_realtime ADD TABLE match_scores;
ALTER PUBLICATION supabase_realtime ADD TABLE standings;
