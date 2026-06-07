CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE leagues (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL DEFAULT 'World Cup Fantasy 2026',
  commissioner_id UUID,
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE managers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  league_id UUID,
  display_name TEXT NOT NULL,
  draft_slot INTEGER CHECK (draft_slot BETWEEN 1 AND 10),
  is_commissioner BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX manager_league_user ON managers(league_id, user_id);
CREATE UNIQUE INDEX manager_slot ON managers(league_id, draft_slot) WHERE draft_slot IS NOT NULL;

ALTER TABLE leagues ADD CONSTRAINT leagues_commissioner_id_fkey FOREIGN KEY (commissioner_id) REFERENCES managers(id) ON DELETE SET NULL;
ALTER TABLE managers ADD CONSTRAINT managers_league_id_fkey FOREIGN KEY (league_id) REFERENCES leagues(id) ON DELETE CASCADE;

CREATE TABLE players (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ext_player_id TEXT UNIQUE,
  name TEXT NOT NULL,
  nation TEXT NOT NULL,
  club TEXT,
  position TEXT NOT NULL CHECK (position IN ('GK','DEF','MID','FWD')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','withdrawn')),
  ranking INTEGER,
  photo_url TEXT,        -- Player headshot from API-Football
  nation_flag_url TEXT,  -- National team crest or flagcdn.com URL
  club_name TEXT,        -- Player's current club team name
  club_logo_url TEXT,    -- Player's current club crest URL
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX players_position ON players(position);
CREATE INDEX players_nation ON players(nation);
CREATE INDEX players_status ON players(status);

CREATE TABLE draft_state (
  league_id UUID PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','in_progress','paused','complete')),
  current_pick_no INTEGER NOT NULL DEFAULT 0,
  current_manager_id UUID,
  round_no INTEGER NOT NULL DEFAULT 0,
  pick_deadline TIMESTAMPTZ,
  timer_seconds INTEGER NOT NULL DEFAULT 60
);

ALTER TABLE draft_state ADD CONSTRAINT draft_state_league_id_fkey FOREIGN KEY (league_id) REFERENCES leagues(id) ON DELETE CASCADE;
ALTER TABLE draft_state ADD CONSTRAINT draft_state_current_manager_id_fkey FOREIGN KEY (current_manager_id) REFERENCES managers(id);

CREATE TABLE draft_picks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  league_id UUID NOT NULL,
  pick_no INTEGER NOT NULL CHECK (pick_no BETWEEN 1 AND 150),
  round_no INTEGER NOT NULL DEFAULT 0,
  manager_id UUID NOT NULL,
  player_id UUID NOT NULL,
  auto_pick BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (league_id, player_id),
  UNIQUE (league_id, pick_no)
);

ALTER TABLE draft_picks ADD CONSTRAINT draft_picks_league_id_fkey FOREIGN KEY (league_id) REFERENCES leagues(id) ON DELETE CASCADE;
ALTER TABLE draft_picks ADD CONSTRAINT draft_picks_manager_id_fkey FOREIGN KEY (manager_id) REFERENCES managers(id) ON DELETE CASCADE;
ALTER TABLE draft_picks ADD CONSTRAINT draft_picks_player_id_fkey FOREIGN KEY (player_id) REFERENCES players(id);
CREATE INDEX draft_picks_league ON draft_picks(league_id);
CREATE INDEX draft_picks_manager ON draft_picks(manager_id);

CREATE TABLE pick_queues (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  manager_id UUID NOT NULL,
  player_id UUID NOT NULL,
  rank INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (manager_id, player_id),
  UNIQUE (manager_id, rank)
);

ALTER TABLE pick_queues ADD CONSTRAINT pick_queues_manager_id_fkey FOREIGN KEY (manager_id) REFERENCES managers(id) ON DELETE CASCADE;
ALTER TABLE pick_queues ADD CONSTRAINT pick_queues_player_id_fkey FOREIGN KEY (player_id) REFERENCES players(id);

CREATE TABLE rosters (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  manager_id UUID NOT NULL,
  player_id UUID NOT NULL,
  acquired_via TEXT NOT NULL CHECK (acquired_via IN ('draft','transfer','free_agent')),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (manager_id, player_id)
);

ALTER TABLE rosters ADD CONSTRAINT rosters_manager_id_fkey FOREIGN KEY (manager_id) REFERENCES managers(id) ON DELETE CASCADE;
ALTER TABLE rosters ADD CONSTRAINT rosters_player_id_fkey FOREIGN KEY (player_id) REFERENCES players(id);
CREATE INDEX rosters_manager ON rosters(manager_id, active);

CREATE TABLE matchdays (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  league_id UUID NOT NULL,
  phase TEXT NOT NULL,
  label TEXT NOT NULL,
  lock_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE matchdays ADD CONSTRAINT matchdays_league_id_fkey FOREIGN KEY (league_id) REFERENCES leagues(id) ON DELETE CASCADE;
CREATE INDEX matchdays_league ON matchdays(league_id);

CREATE TABLE lineups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  manager_id UUID NOT NULL,
  matchday_id UUID NOT NULL,
  player_id UUID NOT NULL,
  slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 11),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (manager_id, matchday_id, player_id),
  UNIQUE (manager_id, matchday_id, slot)
);

ALTER TABLE lineups ADD CONSTRAINT lineups_manager_id_fkey FOREIGN KEY (manager_id) REFERENCES managers(id) ON DELETE CASCADE;
ALTER TABLE lineups ADD CONSTRAINT lineups_matchday_id_fkey FOREIGN KEY (matchday_id) REFERENCES matchdays(id) ON DELETE CASCADE;
ALTER TABLE lineups ADD CONSTRAINT lineups_player_id_fkey FOREIGN KEY (player_id) REFERENCES players(id);
CREATE INDEX lineups_matchday ON lineups(manager_id, matchday_id);

CREATE TABLE transfer_windows (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  league_id UUID NOT NULL,
  phase TEXT NOT NULL,
  opens_at TIMESTAMPTZ NOT NULL,
  closes_at TIMESTAMPTZ NOT NULL,
  free_count INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE transfer_windows ADD CONSTRAINT transfer_windows_league_id_fkey FOREIGN KEY (league_id) REFERENCES leagues(id) ON DELETE CASCADE;
CREATE INDEX transfer_windows_league ON transfer_windows(league_id);

CREATE TABLE transfers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  manager_id UUID NOT NULL,
  window_id UUID,
  out_player_id UUID NOT NULL,
  in_player_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (manager_id, window_id, out_player_id)
);

ALTER TABLE transfers ADD CONSTRAINT transfers_manager_id_fkey FOREIGN KEY (manager_id) REFERENCES managers(id) ON DELETE CASCADE;
ALTER TABLE transfers ADD CONSTRAINT transfers_window_id_fkey FOREIGN KEY (window_id) REFERENCES transfer_windows(id);
ALTER TABLE transfers ADD CONSTRAINT transfers_out_player_id_fkey FOREIGN KEY (out_player_id) REFERENCES players(id);
ALTER TABLE transfers ADD CONSTRAINT transfers_in_player_id_fkey FOREIGN KEY (in_player_id) REFERENCES players(id);

CREATE TABLE fixtures (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  league_id UUID NOT NULL,
  ext_fixture_id TEXT UNIQUE,
  phase TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  kickoff_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','in_progress','finished','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE fixtures ADD CONSTRAINT fixtures_league_id_fkey FOREIGN KEY (league_id) REFERENCES leagues(id) ON DELETE CASCADE;
CREATE INDEX fixtures_league ON fixtures(league_id, phase);

CREATE TABLE player_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_id UUID NOT NULL,
  fixture_id UUID NOT NULL,
  ext_event_id TEXT UNIQUE,
  event_type TEXT NOT NULL,
  minute INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (fixture_id, player_id, event_type, ext_event_id)
);

ALTER TABLE player_events ADD CONSTRAINT player_events_player_id_fkey FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE;
ALTER TABLE player_events ADD CONSTRAINT player_events_fixture_id_fkey FOREIGN KEY (fixture_id) REFERENCES fixtures(id) ON DELETE CASCADE;
CREATE INDEX player_events_player ON player_events(player_id);
CREATE INDEX player_events_fixture ON player_events(fixture_id);

CREATE TABLE match_scores (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_id UUID NOT NULL,
  fixture_id UUID NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  breakdown JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (player_id, fixture_id)
);

ALTER TABLE match_scores ADD CONSTRAINT match_scores_player_id_fkey FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE;
ALTER TABLE match_scores ADD CONSTRAINT match_scores_fixture_id_fkey FOREIGN KEY (fixture_id) REFERENCES fixtures(id) ON DELETE CASCADE;
CREATE INDEX match_scores_player ON match_scores(player_id);
CREATE INDEX match_scores_fixture ON match_scores(fixture_id);

CREATE TABLE standings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  manager_id UUID UNIQUE NOT NULL,
  total_points INTEGER NOT NULL DEFAULT 0,
  by_phase JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE standings ADD CONSTRAINT standings_manager_id_fkey FOREIGN KEY (manager_id) REFERENCES managers(id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER t_updated_at_leagues BEFORE UPDATE ON leagues FOR EACH ROW EXECUTE FUNCTION updated_at();
CREATE TRIGGER t_updated_at_managers BEFORE UPDATE ON managers FOR EACH ROW EXECUTE FUNCTION updated_at();
CREATE TRIGGER t_updated_at_players BEFORE UPDATE ON players FOR EACH ROW EXECUTE FUNCTION updated_at();
CREATE TRIGGER t_updated_at_draft_picks BEFORE UPDATE ON draft_picks FOR EACH ROW EXECUTE FUNCTION updated_at();
CREATE TRIGGER t_updated_at_rosters BEFORE UPDATE ON rosters FOR EACH ROW EXECUTE FUNCTION updated_at();
CREATE TRIGGER t_updated_at_matchdays BEFORE UPDATE ON matchdays FOR EACH ROW EXECUTE FUNCTION updated_at();
CREATE TRIGGER t_updated_at_lineups BEFORE UPDATE ON lineups FOR EACH ROW EXECUTE FUNCTION updated_at();
CREATE TRIGGER t_updated_at_transfer_windows BEFORE UPDATE ON transfer_windows FOR EACH ROW EXECUTE FUNCTION updated_at();
CREATE TRIGGER t_updated_at_transfers BEFORE UPDATE ON transfers FOR EACH ROW EXECUTE FUNCTION updated_at();
CREATE TRIGGER t_updated_at_fixtures BEFORE UPDATE ON fixtures FOR EACH ROW EXECUTE FUNCTION updated_at();
CREATE TRIGGER t_updated_at_player_events BEFORE UPDATE ON player_events FOR EACH ROW EXECUTE FUNCTION updated_at();
CREATE TRIGGER t_updated_at_match_scores BEFORE UPDATE ON match_scores FOR EACH ROW EXECUTE FUNCTION updated_at();
CREATE TRIGGER t_updated_at_standings BEFORE UPDATE ON standings FOR EACH ROW EXECUTE FUNCTION updated_at();

ALTER PUBLICATION supabase_realtime ADD TABLE draft_state;
ALTER PUBLICATION supabase_realtime ADD TABLE draft_picks;
ALTER PUBLICATION supabase_realtime ADD TABLE players;
ALTER PUBLICATION supabase_realtime ADD TABLE match_scores;
ALTER PUBLICATION supabase_realtime ADD TABLE standings;

ALTER TABLE leagues ENABLE ROW LEVEL SECURITY;
ALTER TABLE managers ENABLE ROW LEVEL SECURITY;
ALTER TABLE players ENABLE ROW LEVEL SECURITY;
ALTER TABLE draft_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE draft_picks ENABLE ROW LEVEL SECURITY;
ALTER TABLE pick_queues ENABLE ROW LEVEL SECURITY;
ALTER TABLE rosters ENABLE ROW LEVEL SECURITY;
ALTER TABLE matchdays ENABLE ROW LEVEL SECURITY;
ALTER TABLE lineups ENABLE ROW LEVEL SECURITY;
ALTER TABLE transfer_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE fixtures ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE match_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE standings ENABLE ROW LEVEL SECURITY;

CREATE POLICY managers_select ON managers FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY managers_insert ON managers FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY draft_picks_read ON draft_picks FOR SELECT USING (league_id IN (SELECT league_id FROM managers WHERE user_id = auth.uid()));
CREATE POLICY pick_queue_own ON pick_queues FOR ALL USING (manager_id IN (SELECT id FROM managers WHERE user_id = auth.uid()));
CREATE POLICY roster_read ON rosters FOR SELECT USING (manager_id IN (SELECT id FROM managers WHERE user_id = auth.uid()));
CREATE POLICY roster_write ON rosters FOR ALL USING (manager_id IN (SELECT id FROM managers WHERE user_id = auth.uid()));
CREATE POLICY lineups_own ON lineups FOR ALL USING (manager_id IN (SELECT id FROM managers WHERE user_id = auth.uid()));
CREATE POLICY transfers_read ON transfers FOR SELECT USING (manager_id IN (SELECT id FROM managers WHERE user_id = auth.uid()));
CREATE POLICY players_read ON players FOR SELECT USING (true);
CREATE POLICY standings_read ON standings FOR SELECT USING (manager_id IN (SELECT id FROM managers WHERE user_id = auth.uid()));
CREATE POLICY match_scores_read ON match_scores FOR SELECT USING (true);
-- Player research / watchlist
CREATE TABLE IF NOT EXISTS player_notes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  manager_id UUID NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  watched BOOLEAN NOT NULL DEFAULT false,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(manager_id, player_id)
);

CREATE INDEX player_notes_manager ON player_notes(manager_id);
CREATE INDEX player_notes_watched ON player_notes(manager_id, watched);

ALTER TABLE player_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY player_notes_own ON player_notes
  FOR ALL USING (
    manager_id IN (SELECT id FROM managers WHERE user_id = auth.uid()::UUID)
  ) WITH CHECK (
    manager_id IN (SELECT id FROM managers WHERE user_id = auth.uid()::UUID)
  );

-- ─── make_pick ───────────────────────────────────────────────────
-- Single-entry point for draft picks.
-- Args: p_player_id (uuid)
-- Enforcement: auth, turn, deadline, round_no, quota max, fillability, uniqueness
CREATE OR REPLACE FUNCTION public.make_pick(p_player_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_manager_id UUID;
  v_league_id UUID := '11111111-1111-1111-1111-111111111111';
  v_draft record;
  v_slot INTEGER;
  v_pick_no INTEGER;
  v_round INTEGER;
  v_next_manager UUID;
  v_deadline TIMESTAMPTZ;
  v_existing INTEGER;
  v_max_slot INTEGER;
  v_player_pos TEXT;
  v_pos_count INTEGER;
  v_total_picks INTEGER;
  v_quota INTEGER;
  v_gk INTEGER; v_def INTEGER; v_mid INTEGER; v_fwd INTEGER;
  v_remaining INTEGER;
BEGIN
  SELECT id INTO v_manager_id FROM managers WHERE user_id = auth.uid()::UUID LIMIT 1;
  IF v_manager_id IS NULL THEN
    RETURN '{"error": "Not a manager in this league"}'::JSONB;
  END IF;

  SELECT * INTO v_draft FROM draft_state WHERE league_id = v_league_id AND status = 'in_progress' LIMIT 1;
  IF NOT FOUND THEN
    RETURN '{"error": "No active draft"}'::JSONB;
  END IF;

  IF v_draft.current_manager_id != v_manager_id THEN
    RETURN json_build_object('error', 'Not your turn', 'current_manager', v_draft.current_manager_id::TEXT, 'your_id', v_manager_id::TEXT);
  END IF;

  IF v_draft.pick_deadline IS NOT NULL AND v_draft.pick_deadline < NOW() THEN
    RETURN '{"error": "Pick deadline passed"}'::JSONB;
  END IF;

  SELECT position INTO v_player_pos FROM players WHERE id = p_player_id;
  IF NOT FOUND THEN
    RETURN '{"error": "Player not found"}'::JSONB;
  END IF;

  IF EXISTS (SELECT 1 FROM draft_picks WHERE league_id = v_league_id AND player_id = p_player_id) THEN
    RETURN '{"error": "Player already drafted"}'::JSONB;
  END IF;

  -- FIX #4: round_no filter — check only current round
  SELECT COUNT(*) INTO v_existing FROM draft_picks
  WHERE manager_id = v_manager_id AND league_id = v_league_id AND round_no = v_draft.round_no;
  IF v_existing > 0 THEN
    RETURN '{"error": "Already picked this round"}'::JSONB;
  END IF;

  SELECT COUNT(*) INTO v_total_picks FROM draft_picks WHERE manager_id = v_manager_id;
  IF v_total_picks >= 15 THEN
    RETURN '{"error": "Squad full (15 players)"}'::JSONB;
  END IF;

  -- Position max quota
  v_quota := CASE v_player_pos WHEN 'GK' THEN 2 WHEN 'DEF' THEN 5 WHEN 'MID' THEN 5 WHEN 'FWD' THEN 3 ELSE 99 END;
  SELECT COUNT(*) INTO v_pos_count FROM rosters ro JOIN players p ON p.id = ro.player_id
  WHERE ro.manager_id = v_manager_id AND ro.active = true AND p.position = v_player_pos;
  IF v_pos_count >= v_quota THEN
    RETURN json_build_object('error', v_player_pos || ' quota exceeded (max ' || v_quota || ')');
  END IF;

  -- FIX #2: Fillability check
  SELECT
    COUNT(CASE WHEN p.position = 'GK' THEN 1 END),
    COUNT(CASE WHEN p.position = 'DEF' THEN 1 END),
    COUNT(CASE WHEN p.position = 'MID' THEN 1 END),
    COUNT(CASE WHEN p.position = 'FWD' THEN 1 END)
  INTO v_gk, v_def, v_mid, v_fwd
  FROM rosters ro JOIN players p ON p.id = ro.player_id
  WHERE ro.manager_id = v_manager_id AND ro.active = true;

  IF v_player_pos = 'GK' THEN v_gk := v_gk + 1;
  ELSIF v_player_pos = 'DEF' THEN v_def := v_def + 1;
  ELSIF v_player_pos = 'MID' THEN v_mid := v_mid + 1;
  ELSIF v_player_pos = 'FWD' THEN v_fwd := v_fwd + 1;
  END IF;

  v_remaining := 15 - (v_gk + v_def + v_mid + v_fwd);

  IF v_gk + v_remaining < 2 THEN RETURN '{"error": "Pick would make GK quota unfillable"}'::JSONB; END IF;
  IF v_def + v_remaining < 5 THEN RETURN '{"error": "Pick would make DEF quota unfillable"}'::JSONB; END IF;
  IF v_mid + v_remaining < 5 THEN RETURN '{"error": "Pick would make MID quota unfillable"}'::JSONB; END IF;
  IF v_fwd + v_remaining < 3 THEN RETURN '{"error": "Pick would make FWD quota unfillable"}'::JSONB; END IF;

  INSERT INTO draft_picks (manager_id, player_id, pick_no, round_no, league_id, auto_pick)
  VALUES (v_manager_id, p_player_id, v_draft.current_pick_no, v_draft.round_no, v_league_id, false)
  ON CONFLICT DO NOTHING;

  INSERT INTO rosters (manager_id, player_id, acquired_via, active)
  VALUES (v_manager_id, p_player_id, 'draft', true)
  ON CONFLICT (manager_id, player_id) DO UPDATE SET active = true;

  v_pick_no := v_draft.current_pick_no;
  v_round := v_draft.round_no;

  IF v_pick_no >= 150 THEN
    UPDATE draft_state SET status = 'complete' WHERE league_id = v_league_id;
    RETURN json_build_object('ok', true, 'pick_no', v_pick_no, 'draft_complete', true);
  END IF;

  SELECT draft_slot INTO v_slot FROM managers WHERE id = v_manager_id;
  SELECT COALESCE(MAX(draft_slot), 1) INTO v_max_slot FROM managers;

  IF v_round % 2 = 1 THEN
    IF v_slot >= v_max_slot THEN SELECT id INTO v_next_manager FROM managers WHERE draft_slot = 1 LIMIT 1;
    ELSE SELECT id INTO v_next_manager FROM managers WHERE draft_slot = v_slot + 1 LIMIT 1; END IF;
  ELSE
    IF v_slot <= 1 THEN SELECT id INTO v_next_manager FROM managers WHERE draft_slot = v_max_slot LIMIT 1;
    ELSE SELECT id INTO v_next_manager FROM managers WHERE draft_slot = v_slot - 1 LIMIT 1; END IF;
  END IF;

  IF v_next_manager IS NULL THEN v_next_manager := v_draft.current_manager_id; END IF;
  v_deadline := NOW() + (v_draft.timer_seconds || ' seconds')::INTERVAL;

  UPDATE draft_state SET
    current_pick_no = v_pick_no + 1,
    round_no = CASE WHEN (v_pick_no + 1) % 10 = 1 THEN v_round + 1 ELSE v_round END,
    current_manager_id = v_next_manager,
    pick_deadline = v_deadline
  WHERE league_id = v_league_id;

  RETURN json_build_object('ok', true, 'pick_no', v_pick_no, 'draft_complete', false);
END;
$function$;

-- ─── make_transfer ─────────────────────────────────────────────
-- Single entry point: 3-arg form (p_out_id, p_in_id, p_window_id)
-- Writes to both transfers (ledger) and transfer_requests (audit)
CREATE OR REPLACE FUNCTION public.make_transfer(p_out_id uuid, p_in_id uuid, p_window_id uuid DEFAULT NULL)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_manager_id UUID;
  v_league_id UUID := '11111111-1111-1111-1111-111111111111';
  v_count INTEGER;
BEGIN
  SELECT id INTO v_manager_id FROM managers WHERE user_id = auth.uid()::UUID LIMIT 1;
  IF v_manager_id IS NULL THEN RETURN '{"error": "Not a manager"}'::JSON; END IF;

  -- Verify out_player in roster
  IF NOT EXISTS (SELECT 1 FROM rosters WHERE manager_id = v_manager_id AND player_id = p_out_id AND active = true) THEN
    RETURN '{"error": "Player not in your roster"}'::JSON;
  END IF;

  -- Verify in_player is free agent
  IF EXISTS (SELECT 1 FROM rosters WHERE player_id = p_in_id AND active = true) THEN
    RETURN '{"error": "Player already owned"}'::JSON;
  END IF;

  -- Verify in_player active
  IF NOT EXISTS (SELECT 1 FROM players WHERE id = p_in_id AND status = 'active') THEN
    RETURN '{"error": "Player not active"}'::JSON;
  END IF;

  -- Squad must not be full
  SELECT COUNT(*) INTO v_count FROM rosters WHERE manager_id = v_manager_id AND active = true;
  IF v_count >= 15 THEN RETURN '{"error": "Squad full"}'::JSON; END IF;

  -- Swap
  UPDATE rosters SET active = false WHERE manager_id = v_manager_id AND player_id = p_out_id;
  INSERT INTO rosters (manager_id, player_id, acquired_via, active) VALUES (v_manager_id, p_in_id, 'transfer', true);

  -- Audit trail (transfer_requests) + ledger (transfers)
  INSERT INTO transfer_requests (manager_id, transfer_window_id, out_player_id, in_player_id, status)
  VALUES (v_manager_id, p_window_id, p_out_id, p_in_id, 'approved');

  INSERT INTO transfers (manager_id, window_id, out_player_id, in_player_id)
  VALUES (v_manager_id, p_window_id, p_out_id, p_in_id);

  RETURN '{"ok": true}'::JSON;
END;
$function$;
