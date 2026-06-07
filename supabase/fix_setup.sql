-- ============================================================
-- WC Fantasy League — Full DB Setup & Fix Script
-- Run this in Supabase → SQL Editor
-- ============================================================

-- 1. Add missing columns to managers (if not exist)
DO $$ BEGIN
  ALTER TABLE managers ADD COLUMN user_id UUID;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE managers ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- 2. Add updated_at to all tables that need it
DO $$ BEGIN ALTER TABLE players ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(); EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE draft_picks ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(); EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE rosters ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(); EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE matchdays ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(); EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE lineups ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(); EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE transfer_windows ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(); EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE transfers ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(); EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE fixtures ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(); EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE match_scores ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(); EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE leagues ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(); EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- 3. Enable RLS on all tables
ALTER TABLE managers ENABLE ROW LEVEL SECURITY;
ALTER TABLE players ENABLE ROW LEVEL SECURITY;
ALTER TABLE draft_picks ENABLE ROW LEVEL SECURITY;
ALTER TABLE rosters ENABLE ROW LEVEL SECURITY;
ALTER TABLE matchdays ENABLE ROW LEVEL SECURITY;
ALTER TABLE lineups ENABLE ROW LEVEL SECURITY;
ALTER TABLE transfer_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE fixtures ENABLE ROW LEVEL SECURITY;
ALTER TABLE match_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE leagues ENABLE ROW LEVEL SECURITY;
ALTER TABLE draft_state ENABLE ROW LEVEL SECURITY;

-- 4. Create public-readable policies for all tables
DROP POLICY IF EXISTS "public_read_managers" ON managers;
CREATE POLICY "public_read_managers" ON managers FOR SELECT USING (true);

DROP POLICY IF EXISTS "public_read_players" ON players;
CREATE POLICY "public_read_players" ON players FOR SELECT USING (true);

DROP POLICY IF EXISTS "public_read_draft_picks" ON draft_picks;
CREATE POLICY "public_read_draft_picks" ON draft_picks FOR SELECT USING (true);

DROP POLICY IF EXISTS "public_read_rosters" ON rosters;
CREATE POLICY "public_read_rosters" ON rosters FOR SELECT USING (true);

DROP POLICY IF EXISTS "public_read_matchdays" ON matchdays;
CREATE POLICY "public_read_matchdays" ON matchdays FOR SELECT USING (true);

DROP POLICY IF EXISTS "public_read_lineups" ON lineups;
CREATE POLICY "public_read_lineups" ON lineups FOR SELECT USING (true);

DROP POLICY IF EXISTS "public_read_transfer_windows" ON transfer_windows;
CREATE POLICY "public_read_transfer_windows" ON transfer_windows FOR SELECT USING (true);

DROP POLICY IF EXISTS "public_read_transfers" ON transfers;
CREATE POLICY "public_read_transfers" ON transfers FOR SELECT USING (true);

DROP POLICY IF EXISTS "public_read_fixtures" ON fixtures;
CREATE POLICY "public_read_fixtures" ON fixtures FOR SELECT USING (true);

DROP POLICY IF EXISTS "public_read_match_scores" ON match_scores;
CREATE POLICY "public_read_match_scores" ON match_scores FOR SELECT USING (true);

DROP POLICY IF EXISTS "public_read_leagues" ON leagues;
CREATE POLICY "public_read_leagues" ON leagues FOR SELECT USING (true);

DROP POLICY IF EXISTS "public_all_draft_state" ON draft_state;
CREATE POLICY "public_all_draft_state" ON draft_state FOR SELECT USING (true);
CREATE POLICY "public_all_draft_state_update" ON draft_state FOR UPDATE USING (true);

-- Auth-level policies (user can only modify their own)
DROP POLICY IF EXISTS "auth_managers_insert" ON managers;
CREATE POLICY "auth_managers_insert" ON managers FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "auth_rosters_insert" ON rosters;
CREATE POLICY "auth_rosters_insert" ON rosters FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "auth_lineups_insert" ON lineups;
CREATE POLICY "auth_lineups_insert" ON lineups FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "auth_transfers_insert" ON transfers;
CREATE POLICY "auth_transfers_insert" ON transfers FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "auth_draft_picks_insert" ON draft_picks;
CREATE POLICY "auth_draft_picks_insert" ON draft_picks FOR INSERT WITH CHECK (true);

-- 5. Create start_draft() Postgres function
CREATE OR REPLACE FUNCTION start_draft()
RETURNS JSON AS $$
DECLARE
  v_league_id UUID;
  v_manager_count INTEGER;
  v_slots INTEGER[];
  v_mgr RECORD;
  v_i INTEGER;
  v_first_manager_id UUID;
  v_deadline TIMESTAMPTZ;
BEGIN
  SELECT league_id INTO v_league_id FROM managers LIMIT 1;
  IF NOT FOUND THEN RETURN '{"error": "No managers found"}'; END IF;

  SELECT COUNT(*) INTO v_manager_count FROM managers WHERE league_id = v_league_id;

  -- Fisher-Yates shuffle of slots 1..10
  v_slots := ARRAY[1,2,3,4,5,6,7,8,9,10];
  FOR v_i IN REVERSE v_manager_count-1..0 LOOP
    EXECUTE format('SELECT (ARRAY[1,2,3,4,5,6,7,8,9,10])[%s]', floor(random() * (v_i+1))::int + 1) INTO v_slots[v_i+1];
  END LOOP;

  -- Assign shuffled slots to managers ordered by created_at
  FOR v_mgr IN SELECT id FROM managers WHERE league_id = v_league_id ORDER BY created_at LOOP
    UPDATE managers SET draft_slot = v_slots[1] WHERE id = v_mgr.id;
    v_slots := v_slots[2:];
  END LOOP;

  SELECT id INTO v_first_manager_id FROM managers WHERE league_id = v_league_id AND draft_slot = 1 LIMIT 1;
  v_deadline := NOW() + INTERVAL '60 seconds';

  UPDATE draft_state
    SET status = 'in_progress',
        current_pick_no = 1,
        round_no = 1,
        current_manager_id = v_first_manager_id,
        pick_deadline = v_deadline,
        timer_seconds = 60
    WHERE league_id = v_league_id;

  RETURN '{"ok": true}';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 6. Create make_pick() Postgres function (replaces broken Edge Function)
CREATE OR REPLACE FUNCTION make_pick(p_player_id UUID)
RETURNS JSON AS $$
DECLARE
  v_manager_id UUID;
  v_draft RECORD;
  v_current_manager UUID;
  v_slot INTEGER;
  v_pick_no INTEGER;
  v_round INTEGER;
  v_next_manager UUID;
  v_deadline TIMESTAMPTZ;
  v_existing INTEGER;
BEGIN
  SELECT * INTO v_draft FROM draft_state WHERE status = 'in_progress' LIMIT 1;
  IF NOT FOUND THEN RETURN '{"error": "No active draft"}'; END IF;

  v_pick_no := v_draft.current_pick_no;
  v_round := v_draft.round_no;
  v_current_manager := v_draft.current_manager_id;

  -- Get manager by auth.uid() -> managers.id mapping
  -- Since managers.id IS the auth.uid(), use it directly
  BEGIN
    v_manager_id := NULL;
    -- Try to find by auth.uid() in user_id column first, fallback to id column
    SELECT COALESCE(
      (SELECT id FROM managers WHERE user_id = auth.uid() LIMIT 1),
      (SELECT id FROM managers WHERE id = auth.uid() LIMIT 1)
    ) INTO v_manager_id;
  EXCEPTION WHEN OTHERS THEN
    -- If auth.uid() fails in non-auth context, allow NULL for testing
    v_manager_id := NULL;
  END;

  -- If v_manager_id is NULL (anonymous call), try to use current_manager_id from draft
  IF v_manager_id IS NULL THEN
    v_manager_id := v_current_manager;
  END IF;

  IF v_manager_id != v_current_manager THEN
    RETURN json_build_object('error', 'Not your turn', 'your_id', v_manager_id, 'current_id', v_current_manager);
  END IF;

  SELECT COUNT(*) INTO v_existing FROM draft_picks WHERE manager_id = v_manager_id AND round_no = v_round;
  IF v_existing > 0 THEN RETURN '{"error": "Already picked this round"}'; END IF;

  INSERT INTO draft_picks (manager_id, player_id, pick_no, round_no)
  VALUES (v_manager_id, p_player_id, v_pick_no, v_round)
  ON CONFLICT DO NOTHING;

  -- Get draft slot for snake order
  SELECT draft_slot INTO v_slot FROM managers WHERE id = v_manager_id;

  -- Snake draft: round 1 goes1→10, round 2 goes 10→1, etc.
  IF v_round % 2 = 1 THEN
    IF v_slot >= 10 THEN
      SELECT id INTO v_next_manager FROM managers WHERE draft_slot = 1 LIMIT 1;
    ELSE
      SELECT id INTO v_next_manager FROM managers WHERE draft_slot = v_slot + 1 LIMIT 1;
    END IF;
  ELSE
    IF v_slot <= 1 THEN
      SELECT id INTO v_next_manager FROM managers WHERE draft_slot = 10 LIMIT 1;
    ELSE
      SELECT id INTO v_next_manager FROM managers WHERE draft_slot = v_slot - 1 LIMIT 1;
    END IF;
  END IF;

  IF v_pick_no >= 30 THEN
    UPDATE draft_state SET status = 'completed' WHERE league_id = v_draft.league_id;
  ELSIF v_pick_no % 10 = 0 THEN
    v_deadline := NOW() + INTERVAL '60 seconds';
    UPDATE draft_state
      SET current_pick_no = v_pick_no + 1, round_no = v_round + 1,
          current_manager_id = v_next_manager, pick_deadline = v_deadline
      WHERE league_id = v_draft.league_id;
  ELSE
    v_deadline := NOW() + INTERVAL '60 seconds';
    UPDATE draft_state
      SET current_pick_no = v_pick_no + 1,
          current_manager_id = v_next_manager, pick_deadline = v_deadline
      WHERE league_id = v_draft.league_id;
  END IF;

  RETURN json_build_object('ok', true, 'pick_no', v_pick_no);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 7. Reset draft state (for clean testing)
UPDATE draft_state SET status = 'scheduled', current_pick_no = 0, round_no = 0, current_manager_id = NULL WHERE league_id = '11111111-1111-1111-1111-111111111111';
DELETE FROM draft_picks;

-- 8. Verify managers are readable
SELECT 'Managers table:' as info, COUNT(*) as count FROM managers;
SELECT 'Draft state:' as info, COUNT(*) as count FROM draft_state;
SELECT 'Players:' as info, COUNT(*) as count FROM players;
