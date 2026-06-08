-- ════════════════════════════════════════════════════════════════
-- Fix: canonical snake-draft advance logic
--
-- Replaces the broken slot-stepping in make_pick / auto_pick (which
-- wrapped instead of bouncing at round boundaries, e.g. pick 11 went
-- to slot 9 instead of slot 10) with a single source of truth:
-- slot_for_pick(pick_no). Also adds FOR UPDATE locking to make_pick.
--
-- This migration matches what is already live on the database; it is
-- safe to re-run (all CREATE OR REPLACE).
-- ════════════════════════════════════════════════════════════════

-- ─── slot_for_pick ──────────────────────────────────────────────
-- Canonical snake mapping: pick_no -> draft_slot (10 managers).
-- Round = ceil(pick_no/10); odd rounds ascend 1..10, even rounds descend 10..1.
CREATE OR REPLACE FUNCTION public.slot_for_pick(p_pick_no INTEGER, p_num_managers INTEGER DEFAULT 10)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN (CEIL(p_pick_no::NUMERIC / p_num_managers)::INTEGER) % 2 = 1
      THEN ((p_pick_no - 1) % p_num_managers) + 1
    ELSE p_num_managers - ((p_pick_no - 1) % p_num_managers)
  END;
$$;

-- ─── make_pick ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.make_pick(p_player_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_manager_id UUID;
  v_league_id UUID := '11111111-1111-1111-1111-111111111111';
  v_draft draft_state%ROWTYPE;
  v_pick_no INTEGER;
  v_round INTEGER;
  v_next_pick INTEGER;
  v_next_slot INTEGER;
  v_next_manager UUID;
  v_deadline TIMESTAMPTZ;
  v_existing INTEGER;
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

  -- Lock draft row to serialize against concurrent picks/auto-picks
  SELECT * INTO v_draft FROM draft_state WHERE league_id = v_league_id AND status = 'in_progress' FOR UPDATE;
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

  SELECT COUNT(*) INTO v_existing FROM draft_picks
  WHERE manager_id = v_manager_id AND league_id = v_league_id AND round_no = v_draft.round_no;
  IF v_existing > 0 THEN
    RETURN '{"error": "Already picked this round"}'::JSONB;
  END IF;

  SELECT COUNT(*) INTO v_total_picks FROM draft_picks WHERE manager_id = v_manager_id;
  IF v_total_picks >= 15 THEN
    RETURN '{"error": "Squad full (15 players)"}'::JSONB;
  END IF;

  v_quota := CASE v_player_pos WHEN 'GK' THEN 2 WHEN 'DEF' THEN 5 WHEN 'MID' THEN 5 WHEN 'FWD' THEN 3 ELSE 99 END;
  SELECT COUNT(*) INTO v_pos_count FROM rosters ro JOIN players p ON p.id = ro.player_id
  WHERE ro.manager_id = v_manager_id AND ro.active = true AND p.position = v_player_pos;
  IF v_pos_count >= v_quota THEN
    RETURN json_build_object('error', v_player_pos || ' quota exceeded (max ' || v_quota || ')');
  END IF;

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

  -- Canonical advance: next slot derived purely from next pick number
  v_next_pick := v_pick_no + 1;
  v_next_slot := public.slot_for_pick(v_next_pick);
  SELECT id INTO v_next_manager FROM managers WHERE draft_slot = v_next_slot LIMIT 1;
  IF v_next_manager IS NULL THEN v_next_manager := v_draft.current_manager_id; END IF;

  v_deadline := NOW() + (v_draft.timer_seconds || ' seconds')::INTERVAL;

  UPDATE draft_state SET
    current_pick_no = v_next_pick,
    round_no = CEIL(v_next_pick::NUMERIC / 10)::INTEGER,
    current_manager_id = v_next_manager,
    pick_deadline = v_deadline
  WHERE league_id = v_league_id;

  RETURN json_build_object('ok', true, 'pick_no', v_pick_no, 'draft_complete', false);
END;
$function$;

-- ─── auto_pick ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.auto_pick(p_league_id UUID, p_manager_id UUID, p_pick_no INTEGER, p_round_no INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_draft draft_state%ROWTYPE;
  v_player RECORD;
  v_next_pick INTEGER;
  v_next_slot INTEGER;
  v_next_manager UUID;
  v_deadline TIMESTAMPTZ;
  v_timer_secs INTEGER DEFAULT 60;
  v_gk INTEGER; v_def INTEGER; v_mid INTEGER; v_fwd INTEGER;
  v_remaining INTEGER;
  v_quota INTEGER;
  v_pos_count INTEGER;
  v_player_pos TEXT;
  v_players_added INTEGER;
BEGIN
  SELECT * INTO v_draft FROM draft_state
  WHERE league_id = p_league_id AND status = 'in_progress'
  FOR UPDATE NOWAIT;

  IF v_draft.pick_deadline > NOW() THEN RETURN json_build_object('skipped', true, 'reason', 'deadline not passed'); END IF;
  IF v_draft.current_pick_no != p_pick_no OR v_draft.round_no != p_round_no THEN
    RETURN json_build_object('skipped', true, 'reason', 'pick_no mismatch');
  END IF;
  IF v_draft.current_manager_id != p_manager_id THEN
    RETURN json_build_object('skipped', true, 'reason', 'manager mismatch');
  END IF;
  IF EXISTS (SELECT 1 FROM draft_picks WHERE league_id = p_league_id AND pick_no = p_pick_no AND round_no = p_round_no) THEN
    RETURN json_build_object('skipped', true, 'reason', 'already picked');
  END IF;

  SELECT
    COUNT(CASE WHEN p.position = 'GK' THEN 1 END),
    COUNT(CASE WHEN p.position = 'DEF' THEN 1 END),
    COUNT(CASE WHEN p.position = 'MID' THEN 1 END),
    COUNT(CASE WHEN p.position = 'FWD' THEN 1 END)
  INTO v_gk, v_def, v_mid, v_fwd
  FROM draft_picks dp JOIN players p ON p.id = dp.player_id
  WHERE dp.manager_id = p_manager_id;

  FOR v_player IN
    SELECT id, name, position FROM players
    WHERE status = 'active'
      AND id NOT IN (SELECT player_id FROM draft_picks WHERE league_id = p_league_id)
    ORDER BY ranking
  LOOP
    v_player_pos := v_player.position;
    v_quota := CASE v_player_pos WHEN 'GK' THEN 2 WHEN 'DEF' THEN 5 WHEN 'MID' THEN 5 WHEN 'FWD' THEN 3 ELSE 99 END;
    v_pos_count := CASE v_player_pos WHEN 'GK' THEN v_gk WHEN 'DEF' THEN v_def WHEN 'MID' THEN v_mid WHEN 'FWD' THEN v_fwd ELSE 0 END;
    CONTINUE WHEN v_pos_count >= v_quota;
    v_remaining := 15 - (v_gk + v_def + v_mid + v_fwd);
    CONTINUE WHEN CASE v_player_pos WHEN 'GK' THEN v_gk + v_remaining < 2 WHEN 'DEF' THEN v_def + v_remaining < 5 WHEN 'MID' THEN v_mid + v_remaining < 5 WHEN 'FWD' THEN v_fwd + v_remaining < 3 ELSE false END;

    INSERT INTO draft_picks (league_id, manager_id, player_id, pick_no, round_no, auto_pick)
    VALUES (p_league_id, p_manager_id, v_player.id, p_pick_no, p_round_no, true)
    ON CONFLICT DO NOTHING;
    INSERT INTO rosters (manager_id, player_id, acquired_via, active)
    VALUES (p_manager_id, v_player.id, 'draft', true)
    ON CONFLICT (manager_id, player_id) DO UPDATE SET active = true;
    v_players_added := 1;
    EXIT;
  END LOOP;

  IF v_players_added IS NULL THEN RETURN json_build_object('error', 'No available player found'); END IF;

  IF v_draft.timer_seconds IS NOT NULL THEN v_timer_secs := v_draft.timer_seconds; END IF;
  v_deadline := NOW() + (v_timer_secs || ' seconds')::INTERVAL;

  IF p_pick_no >= 150 THEN
    UPDATE draft_state SET status = 'complete' WHERE league_id = p_league_id;
    RETURN json_build_object('ok', true, 'pick_no', p_pick_no, 'draft_complete', true);
  END IF;

  -- Canonical advance
  v_next_pick := p_pick_no + 1;
  v_next_slot := public.slot_for_pick(v_next_pick);
  SELECT id INTO v_next_manager FROM managers WHERE draft_slot = v_next_slot LIMIT 1;
  IF v_next_manager IS NULL THEN v_next_manager := p_manager_id; END IF;

  UPDATE draft_state SET
    current_pick_no = v_next_pick,
    round_no = CEIL(v_next_pick::NUMERIC / 10)::INTEGER,
    current_manager_id = v_next_manager,
    pick_deadline = v_deadline
  WHERE league_id = p_league_id;

  RETURN json_build_object('ok', true, 'pick_no', p_pick_no, 'player_id', v_player.id, 'player_name', v_player.name, 'draft_complete', false);
END;
$function$;
