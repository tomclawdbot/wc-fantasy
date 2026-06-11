-- ════════════════════════════════════════════════════════════════
-- tournament-fantasy 0003_functions
-- Every rule value is read from leagues.config. Single scoring path:
--   player_events → rescore_fixture() → match_scores → recompute_standings()
-- The phase multiplier is applied exactly once, in rescore_fixture.
-- Fixes vs v1: hardcoded league UUID, hardcoded 10 managers / 150 picks,
-- three diverging scoring tables, double knockout multiplier, group-stage
-- cross-matchday point bleed, set_lineup "any one player" roster check,
-- set_lineup impersonation (took p_manager_id), unvalidated transfers,
-- auto_pick ignoring the manager's queue.
-- ════════════════════════════════════════════════════════════════

-- ─── config helpers ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION league_config(p_league_id UUID) RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT config FROM leagues WHERE id = p_league_id;
$$;

CREATE OR REPLACE FUNCTION league_manager_count(p_league_id UUID) RETURNS INTEGER
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COUNT(*)::INTEGER FROM managers WHERE league_id = p_league_id AND draft_slot IS NOT NULL;
$$;

-- caller's manager row; errors if not a member
CREATE OR REPLACE FUNCTION caller_manager() RETURNS managers
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE m managers%ROWTYPE;
BEGIN
  SELECT * INTO m FROM managers WHERE user_id = auth.uid() LIMIT 1;
  IF m.id IS NULL THEN RAISE EXCEPTION 'not_a_manager'; END IF;
  RETURN m;
END $$;

-- ─── snake order: pick_no → draft_slot, n managers ───────────────
CREATE OR REPLACE FUNCTION slot_for_pick(p_pick_no INTEGER, p_num_managers INTEGER)
RETURNS INTEGER LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN (CEIL(p_pick_no::NUMERIC / p_num_managers)::INTEGER) % 2 = 1
      THEN ((p_pick_no - 1) % p_num_managers) + 1
    ELSE p_num_managers - ((p_pick_no - 1) % p_num_managers)
  END;
$$;

-- ─── quota validation (config-driven) ────────────────────────────
-- Returns NULL if a pick of p_position is legal for the manager, else error text.
CREATE OR REPLACE FUNCTION check_squad_quota(p_manager_id UUID, p_position TEXT, p_config JSONB)
RETURNS TEXT LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  v_size INTEGER := COALESCE((p_config->'squad'->>'size')::INTEGER, 15);
  v_counts JSONB;
  v_pos TEXT;
  v_have INTEGER;
  v_need INTEGER;
  v_total INTEGER := 0;
  v_remaining INTEGER;
BEGIN
  SELECT COALESCE(jsonb_object_agg(p.position, c), '{}'::jsonb) INTO v_counts
  FROM (
    SELECT pl.position, COUNT(*) AS c
    FROM rosters r JOIN players pl ON pl.id = r.player_id
    WHERE r.manager_id = p_manager_id AND r.active
    GROUP BY pl.position
  ) p;

  FOR v_pos IN SELECT jsonb_object_keys(p_config->'squad'->'quota') LOOP
    v_total := v_total + COALESCE((v_counts->>v_pos)::INTEGER, 0);
  END LOOP;
  IF v_total >= v_size THEN RETURN 'Squad full (' || v_size || ' players)'; END IF;

  v_have := COALESCE((v_counts->>p_position)::INTEGER, 0);
  v_need := COALESCE((p_config->'squad'->'quota'->>p_position)::INTEGER, 0);
  IF v_have >= v_need THEN
    RETURN p_position || ' quota exceeded (max ' || v_need || ')';
  END IF;

  -- fillability: after this pick, every position must still be reachable
  v_counts := jsonb_set(v_counts, ARRAY[p_position], to_jsonb(v_have + 1));
  v_remaining := v_size - (v_total + 1);
  FOR v_pos IN SELECT jsonb_object_keys(p_config->'squad'->'quota') LOOP
    v_have := COALESCE((v_counts->>v_pos)::INTEGER, 0);
    v_need := (p_config->'squad'->'quota'->>v_pos)::INTEGER;
    IF v_have + v_remaining < v_need THEN
      RETURN 'Pick would make ' || v_pos || ' quota unfillable';
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

-- ─── start_draft ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION start_draft() RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me managers%ROWTYPE := caller_manager();
  v_timer INTEGER;
  v_first UUID;
BEGIN
  IF NOT v_me.is_commissioner THEN
    RETURN jsonb_build_object('error', 'Only the commissioner can start the draft');
  END IF;
  v_timer := COALESCE((league_config(v_me.league_id)->'draft'->>'timer_seconds')::INTEGER, 60);
  SELECT id INTO v_first FROM managers WHERE league_id = v_me.league_id AND draft_slot = 1;
  IF v_first IS NULL THEN RETURN jsonb_build_object('error', 'No manager in slot 1'); END IF;

  INSERT INTO draft_state (league_id, status, current_pick_no, round_no, current_manager_id, pick_deadline, timer_seconds)
  VALUES (v_me.league_id, 'in_progress', 1, 1, v_first, now() + make_interval(secs => v_timer), v_timer)
  ON CONFLICT (league_id) DO UPDATE SET
    status = 'in_progress', current_pick_no = 1, round_no = 1,
    current_manager_id = EXCLUDED.current_manager_id,
    pick_deadline = EXCLUDED.pick_deadline, timer_seconds = EXCLUDED.timer_seconds;
  RETURN jsonb_build_object('ok', true);
END $$;

-- ─── internal: record a pick and advance the snake ───────────────
CREATE OR REPLACE FUNCTION _record_pick(
  p_league_id UUID, p_manager_id UUID, p_player_id UUID,
  p_pick_no INTEGER, p_round_no INTEGER, p_auto BOOLEAN, p_timer INTEGER
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_n INTEGER := league_manager_count(p_league_id);
  v_size INTEGER := COALESCE((league_config(p_league_id)->'squad'->>'size')::INTEGER, 15);
  v_total_picks INTEGER := v_n * v_size;
  v_next INTEGER; v_next_mgr UUID;
BEGIN
  INSERT INTO draft_picks (league_id, manager_id, player_id, pick_no, round_no, auto_pick)
  VALUES (p_league_id, p_manager_id, p_player_id, p_pick_no, p_round_no, p_auto);

  INSERT INTO rosters (manager_id, player_id, acquired_via, active)
  VALUES (p_manager_id, p_player_id, 'draft', true)
  ON CONFLICT (manager_id, player_id) DO UPDATE SET active = true;

  IF p_pick_no >= v_total_picks THEN
    UPDATE draft_state SET status = 'complete', pick_deadline = NULL WHERE league_id = p_league_id;
    RETURN jsonb_build_object('ok', true, 'pick_no', p_pick_no, 'draft_complete', true);
  END IF;

  v_next := p_pick_no + 1;
  SELECT id INTO v_next_mgr FROM managers
  WHERE league_id = p_league_id AND draft_slot = slot_for_pick(v_next, v_n);

  UPDATE draft_state SET
    current_pick_no = v_next,
    round_no = CEIL(v_next::NUMERIC / v_n)::INTEGER,
    current_manager_id = v_next_mgr,
    pick_deadline = now() + make_interval(secs => p_timer)
  WHERE league_id = p_league_id;

  RETURN jsonb_build_object('ok', true, 'pick_no', p_pick_no, 'draft_complete', false);
END $$;

-- ─── make_pick ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION make_pick(p_player_id UUID) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me managers%ROWTYPE := caller_manager();
  v_cfg JSONB := league_config(v_me.league_id);
  v_draft draft_state%ROWTYPE;
  v_pos TEXT; v_err TEXT;
BEGIN
  SELECT * INTO v_draft FROM draft_state
  WHERE league_id = v_me.league_id AND status = 'in_progress' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'No active draft'); END IF;
  IF v_draft.current_manager_id != v_me.id THEN RETURN jsonb_build_object('error', 'Not your turn'); END IF;
  IF v_draft.pick_deadline IS NOT NULL AND v_draft.pick_deadline < now() THEN
    RETURN jsonb_build_object('error', 'Pick deadline passed');
  END IF;

  SELECT position INTO v_pos FROM players WHERE id = p_player_id AND status = 'active';
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'Player not found or withdrawn'); END IF;
  IF EXISTS (SELECT 1 FROM draft_picks WHERE league_id = v_me.league_id AND player_id = p_player_id) THEN
    RETURN jsonb_build_object('error', 'Player already drafted');
  END IF;

  v_err := check_squad_quota(v_me.id, v_pos, v_cfg);
  IF v_err IS NOT NULL THEN RETURN jsonb_build_object('error', v_err); END IF;

  RETURN _record_pick(v_me.league_id, v_me.id, p_player_id,
    v_draft.current_pick_no, v_draft.round_no, false, v_draft.timer_seconds);
END $$;

-- ─── auto_pick: queue first, then ranking ────────────────────────
CREATE OR REPLACE FUNCTION auto_pick(p_league_id UUID, p_manager_id UUID, p_pick_no INTEGER, p_round_no INTEGER)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cfg JSONB := league_config(p_league_id);
  v_draft draft_state%ROWTYPE;
  v_player RECORD;
BEGIN
  SELECT * INTO v_draft FROM draft_state
  WHERE league_id = p_league_id AND status = 'in_progress' FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RETURN jsonb_build_object('skipped', true, 'reason', 'no active draft'); END IF;
  IF v_draft.pick_deadline IS NULL OR v_draft.pick_deadline > now() THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'deadline not passed');
  END IF;
  IF v_draft.current_pick_no != p_pick_no OR v_draft.current_manager_id != p_manager_id THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'state mismatch');
  END IF;

  -- candidates: the manager's queue (rank order) first, then ranking order
  FOR v_player IN
    SELECT p.id, p.name, p.position FROM (
      SELECT pl.id, pl.name, pl.position, 0 AS src, q.rank AS ord
      FROM pick_queues q JOIN players pl ON pl.id = q.player_id
      WHERE q.manager_id = p_manager_id AND pl.status = 'active'
      UNION ALL
      SELECT pl.id, pl.name, pl.position, 1 AS src, pl.ranking AS ord
      FROM players pl WHERE pl.status = 'active'
    ) p
    WHERE p.id NOT IN (SELECT player_id FROM draft_picks WHERE league_id = p_league_id)
    ORDER BY p.src, p.ord NULLS LAST
  LOOP
    IF check_squad_quota(p_manager_id, v_player.position, v_cfg) IS NULL THEN
      RETURN _record_pick(p_league_id, p_manager_id, v_player.id, p_pick_no, p_round_no, true, v_draft.timer_seconds)
             || jsonb_build_object('player_id', v_player.id, 'player_name', v_player.name);
    END IF;
  END LOOP;
  RETURN jsonb_build_object('error', 'No legal player available');
END $$;

-- ─── claim_manager_slot: invite-gated, race-safe join ────────────
CREATE OR REPLACE FUNCTION claim_manager_slot() RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_email TEXT;
  v_existing managers%ROWTYPE;
  v_invite allowed_emails%ROWTYPE;
  v_slot RECORD;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'Not signed in'); END IF;
  SELECT * INTO v_existing FROM managers WHERE user_id = v_uid LIMIT 1;
  IF FOUND THEN RETURN to_jsonb(v_existing); END IF;

  SELECT email INTO v_email FROM auth.users WHERE id = v_uid;
  SELECT * INTO v_invite FROM allowed_emails WHERE lower(email) = lower(v_email) LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'Email not on the invite list'); END IF;

  -- claim the lowest unclaimed slot in the invite's league, race-safe
  SELECT * INTO v_slot FROM managers
  WHERE league_id = v_invite.league_id AND user_id IS NULL AND draft_slot IS NOT NULL
  ORDER BY draft_slot LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'League is full'); END IF;

  UPDATE managers SET user_id = v_uid, email = v_email,
    display_name = COALESCE(v_invite.display_name, display_name)
  WHERE id = v_slot.id;
  SELECT * INTO v_existing FROM managers WHERE id = v_slot.id;
  RETURN to_jsonb(v_existing);
END $$;

-- ─── set_lineup: caller-scoped, formation + lock enforced ────────
CREATE OR REPLACE FUNCTION set_lineup(p_matchday_id UUID, p_player_ids UUID[]) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me managers%ROWTYPE := caller_manager();
  v_cfg JSONB := league_config(v_me.league_id);
  v_size INTEGER := COALESCE((v_cfg->'lineup'->>'size')::INTEGER, 11);
  v_md matchdays%ROWTYPE;
  v_missing INTEGER;
  v_pos TEXT; v_count INTEGER; v_min INTEGER; v_max INTEGER;
BEGIN
  SELECT * INTO v_md FROM matchdays WHERE id = p_matchday_id AND league_id = v_me.league_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'Matchday not found'); END IF;
  IF v_md.lock_at <= now() THEN RETURN jsonb_build_object('error', 'Lineup locked for ' || v_md.label); END IF;

  IF array_length(p_player_ids, 1) IS DISTINCT FROM v_size
     OR (SELECT COUNT(DISTINCT x) FROM unnest(p_player_ids) x) != v_size THEN
    RETURN jsonb_build_object('error', 'Must select exactly ' || v_size || ' distinct players');
  END IF;

  -- ALL players must be in the caller's active roster (v1 only checked "at least one")
  SELECT COUNT(*) INTO v_missing FROM unnest(p_player_ids) pid
  WHERE NOT EXISTS (
    SELECT 1 FROM rosters r WHERE r.manager_id = v_me.id AND r.player_id = pid AND r.active
  );
  IF v_missing > 0 THEN
    RETURN jsonb_build_object('error', v_missing || ' player(s) not in your active roster');
  END IF;

  -- formation from config: lineup.min / lineup.max per position
  FOR v_pos IN SELECT jsonb_object_keys(v_cfg->'squad'->'quota') LOOP
    SELECT COUNT(*) INTO v_count FROM unnest(p_player_ids) pid
    JOIN players pl ON pl.id = pid WHERE pl.position = v_pos;
    v_min := COALESCE((v_cfg->'lineup'->'min'->>v_pos)::INTEGER, 0);
    v_max := COALESCE((v_cfg->'lineup'->'max'->>v_pos)::INTEGER, v_size);
    IF v_count < v_min THEN RETURN jsonb_build_object('error', 'Need at least ' || v_min || ' ' || v_pos); END IF;
    IF v_count > v_max THEN RETURN jsonb_build_object('error', 'Max ' || v_max || ' ' || v_pos); END IF;
  END LOOP;

  DELETE FROM lineups WHERE manager_id = v_me.id AND matchday_id = p_matchday_id;
  INSERT INTO lineups (manager_id, matchday_id, player_id, slot)
  SELECT v_me.id, p_matchday_id, pid, ord
  FROM unnest(p_player_ids) WITH ORDINALITY AS u(pid, ord);
  RETURN jsonb_build_object('ok', true, 'count', v_size);
END $$;

-- ─── make_transfer: window, free-count, quota all enforced ───────
CREATE OR REPLACE FUNCTION make_transfer(p_out_id UUID, p_in_id UUID) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me managers%ROWTYPE := caller_manager();
  v_cfg JSONB := league_config(v_me.league_id);
  v_window transfer_windows%ROWTYPE;
  v_used INTEGER;
  v_out_pos TEXT; v_in_pos TEXT;
  v_quota INTEGER; v_count INTEGER;
BEGIN
  SELECT * INTO v_window FROM transfer_windows
  WHERE league_id = v_me.league_id AND opens_at <= now() AND closes_at > now()
  ORDER BY opens_at DESC LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'No transfer window is open'); END IF;

  SELECT COUNT(*) INTO v_used FROM transfers WHERE manager_id = v_me.id AND window_id = v_window.id;
  IF v_used >= v_window.free_count THEN
    RETURN jsonb_build_object('error', 'Transfer limit reached for this window (' || v_window.free_count || ')');
  END IF;

  SELECT pl.position INTO v_out_pos FROM rosters r JOIN players pl ON pl.id = r.player_id
  WHERE r.manager_id = v_me.id AND r.player_id = p_out_id AND r.active;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'Player not in your roster'); END IF;

  SELECT position INTO v_in_pos FROM players WHERE id = p_in_id AND status = 'active';
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'Incoming player not found or withdrawn'); END IF;
  IF EXISTS (
    SELECT 1 FROM rosters r JOIN managers m ON m.id = r.manager_id
    WHERE r.player_id = p_in_id AND r.active AND m.league_id = v_me.league_id
  ) THEN RETURN jsonb_build_object('error', 'Player already owned'); END IF;

  -- quota preserved: position counts after the swap must respect config
  IF v_in_pos != v_out_pos THEN
    v_quota := COALESCE((v_cfg->'squad'->'quota'->>v_in_pos)::INTEGER, 99);
    SELECT COUNT(*) INTO v_count FROM rosters r JOIN players pl ON pl.id = r.player_id
    WHERE r.manager_id = v_me.id AND r.active AND pl.position = v_in_pos;
    IF v_count >= v_quota THEN
      RETURN jsonb_build_object('error', v_in_pos || ' quota exceeded after transfer');
    END IF;
  END IF;

  UPDATE rosters SET active = false WHERE manager_id = v_me.id AND player_id = p_out_id;
  INSERT INTO rosters (manager_id, player_id, acquired_via, active)
  VALUES (v_me.id, p_in_id, 'transfer', true)
  ON CONFLICT (manager_id, player_id) DO UPDATE SET active = true, acquired_via = 'transfer';
  INSERT INTO transfers (manager_id, window_id, out_player_id, in_player_id)
  VALUES (v_me.id, v_window.id, p_out_id, p_in_id);

  -- swap into any unlocked lineups so the manager isn't left short
  UPDATE lineups l SET player_id = p_in_id
  FROM matchdays md
  WHERE l.matchday_id = md.id AND md.lock_at > now()
    AND l.manager_id = v_me.id AND l.player_id = p_out_id;

  RETURN jsonb_build_object('ok', true, 'window', v_window.phase, 'used', v_used + 1, 'free_count', v_window.free_count);
END $$;

-- ─── SCORING: the only place points are computed ─────────────────
CREATE OR REPLACE FUNCTION score_event_points(p_event_type TEXT, p_qty INTEGER, p_position TEXT, p_scoring JSONB)
RETURNS INTEGER LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v JSONB;
BEGIN
  v := p_scoring->CASE p_event_type
    WHEN 'Appearance'    THEN 'appearance'
    WHEN 'Goal'          THEN 'goal'
    WHEN 'Assist'        THEN 'assist'
    WHEN 'CleanSheet'    THEN 'clean_sheet'
    WHEN 'Save'          THEN 'save'
    WHEN 'YellowCard'    THEN 'yellow_card'
    WHEN 'SecondYellow'  THEN 'second_yellow'
    WHEN 'RedCard'       THEN 'red_card'
    WHEN 'OwnGoal'       THEN 'own_goal'
    WHEN 'PenaltyMissed' THEN 'penalty_missed'
    WHEN 'PenaltySaved'  THEN 'penalty_saved'
    ELSE NULL END;
  IF v IS NULL THEN RETURN 0; END IF;
  -- value may be a number or a per-position object {"GK":4,...}
  IF jsonb_typeof(v) = 'object' THEN
    RETURN COALESCE((v->>p_position)::INTEGER, 0) * p_qty;
  END IF;
  RETURN COALESCE(v::TEXT::INTEGER, 0) * p_qty;
END $$;

CREATE OR REPLACE FUNCTION phase_multiplier(p_league_id UUID, p_phase TEXT)
RETURNS NUMERIC LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE((
    SELECT (ph->>'multiplier')::NUMERIC
    FROM jsonb_array_elements(league_config(p_league_id)->'phases') ph
    WHERE ph->>'key' = p_phase
  ), 1);
$$;

-- Rebuild match_scores for one fixture from raw player_events.
-- Multiplier applied here, ONCE. Eliminated-team players score 0.
CREATE OR REPLACE FUNCTION rescore_fixture(p_fixture_id UUID) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_fx fixtures%ROWTYPE;
  v_scoring JSONB;
  v_mult NUMERIC;
  v_rows INTEGER;
BEGIN
  SELECT * INTO v_fx FROM fixtures WHERE id = p_fixture_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'Fixture not found'); END IF;
  v_scoring := league_config(v_fx.league_id)->'scoring';
  v_mult := phase_multiplier(v_fx.league_id, v_fx.phase);

  DELETE FROM match_scores WHERE fixture_id = p_fixture_id;

  INSERT INTO match_scores (player_id, fixture_id, points, breakdown)
  SELECT
    e.player_id, p_fixture_id,
    ROUND(SUM(score_event_points(e.event_type, e.qty, pl.position, v_scoring)) * v_mult)::INTEGER,
    jsonb_object_agg(e.event_type, jsonb_build_object(
      'qty', e.qty,
      'pts', score_event_points(e.event_type, e.qty, pl.position, v_scoring)
    )) || jsonb_build_object('multiplier', v_mult)
  FROM (
    SELECT player_id, event_type, SUM(qty)::INTEGER AS qty
    FROM player_events WHERE fixture_id = p_fixture_id
    GROUP BY player_id, event_type
  ) e
  JOIN players pl ON pl.id = e.player_id
  WHERE NOT EXISTS (
    SELECT 1 FROM tournament_teams tt
    WHERE tt.league_id = v_fx.league_id AND tt.team = pl.nation
      AND tt.eliminated_at IS NOT NULL AND tt.eliminated_at < v_fx.kickoff_at
  )
  GROUP BY e.player_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'players_scored', v_rows);
END $$;

-- Standings: sum match_scores through lineups, joined on the fixture's
-- OWN matchday (fixes v1 phase-join bleed). No multiplier here.
CREATE OR REPLACE FUNCTION recompute_standings(p_league_id UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO standings (manager_id, total_points, by_phase, updated_at)
  SELECT
    m.id,
    COALESCE(SUM(ms.points), 0)::INTEGER,
    COALESCE(
      (SELECT jsonb_object_agg(phase, pts) FROM (
        SELECT md2.phase, SUM(ms2.points)::INTEGER AS pts
        FROM lineups l2
        JOIN matchdays md2 ON md2.id = l2.matchday_id
        JOIN fixtures f2 ON f2.matchday_id = md2.id
        JOIN match_scores ms2 ON ms2.fixture_id = f2.id AND ms2.player_id = l2.player_id
        WHERE l2.manager_id = m.id
        GROUP BY md2.phase
      ) x), '{}'::jsonb),
    now()
  FROM managers m
  LEFT JOIN lineups l ON l.manager_id = m.id
  LEFT JOIN matchdays md ON md.id = l.matchday_id
  LEFT JOIN fixtures f ON f.matchday_id = md.id
  LEFT JOIN match_scores ms ON ms.fixture_id = f.id AND ms.player_id = l.player_id
  WHERE m.league_id = p_league_id
  GROUP BY m.id
  ON CONFLICT (manager_id) DO UPDATE SET
    total_points = EXCLUDED.total_points,
    by_phase = EXCLUDED.by_phase,
    updated_at = now();
END $$;

-- ─── player listing / search (RPC, paginated) ────────────────────
CREATE OR REPLACE FUNCTION get_all_players(p_offset INTEGER DEFAULT 0, p_limit INTEGER DEFAULT 1000)
RETURNS TABLE (
  id UUID, ext_player_id TEXT, name TEXT, nation TEXT, club TEXT, club_name TEXT,
  "position" TEXT, status TEXT, ranking INTEGER, in_squad BOOLEAN,
  photo_url TEXT, nation_flag_url TEXT, club_logo_url TEXT,
  owner_manager_id UUID, owner_team_name TEXT
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id, p.ext_player_id, p.name, p.nation, p.club, p.club_name,
         p.position, p.status, p.ranking, p.in_squad,
         p.photo_url, p.nation_flag_url, p.club_logo_url,
         r.manager_id, COALESCE(m.team_name, m.display_name)
  FROM players p
  LEFT JOIN rosters r ON r.player_id = p.id AND r.active
  LEFT JOIN managers m ON m.id = r.manager_id
  ORDER BY p.ranking NULLS LAST, p.name
  OFFSET p_offset LIMIT LEAST(p_limit, 1000);
$$;

CREATE OR REPLACE FUNCTION search_players(search_query TEXT, limit_count INTEGER DEFAULT 50)
RETURNS SETOF players LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT * FROM players
  WHERE name % search_query OR name ILIKE '%' || search_query || '%'
  ORDER BY similarity(name, search_query) DESC, ranking NULLS LAST
  LIMIT LEAST(limit_count, 100);
$$;
