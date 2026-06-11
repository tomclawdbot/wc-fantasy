-- ════════════════════════════════════════════════════════════════
-- tournament-fantasy 0002_rls
-- Fixes vs v1:
--  * standings had `FOR ALL USING (true)` — any signed-in user could
--    rewrite the league table. Removed: only the service role (which
--    bypasses RLS) and SECURITY DEFINER functions write standings.
--  * managers were only visible to themselves, breaking every join
--    (draft board, standings names). Now league-visible.
--  * No client INSERT on managers — slot claims go through the
--    claim_manager_slot() function, which enforces allowed_emails.
--  * Mutations on rosters/lineups/transfers/draft_picks only happen
--    through SECURITY DEFINER functions; no permissive write policies.
--  * tournament_teams (was wc_nations, which had RLS disabled) is
--    read-only to authenticated users.
-- ════════════════════════════════════════════════════════════════

ALTER TABLE leagues          ENABLE ROW LEVEL SECURITY;
ALTER TABLE managers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE allowed_emails   ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournament_teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE players          ENABLE ROW LEVEL SECURITY;
ALTER TABLE draft_state      ENABLE ROW LEVEL SECURITY;
ALTER TABLE draft_picks      ENABLE ROW LEVEL SECURITY;
ALTER TABLE pick_queues      ENABLE ROW LEVEL SECURITY;
ALTER TABLE rosters          ENABLE ROW LEVEL SECURITY;
ALTER TABLE matchdays        ENABLE ROW LEVEL SECURITY;
ALTER TABLE fixtures         ENABLE ROW LEVEL SECURITY;
ALTER TABLE lineups          ENABLE ROW LEVEL SECURITY;
ALTER TABLE transfer_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE transfers        ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_events    ENABLE ROW LEVEL SECURITY;
ALTER TABLE match_scores     ENABLE ROW LEVEL SECURITY;
ALTER TABLE standings        ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_notes     ENABLE ROW LEVEL SECURITY;

-- helper: leagues the current user belongs to
CREATE OR REPLACE FUNCTION my_league_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT league_id FROM managers WHERE user_id = auth.uid();
$$;

-- helper: my manager ids
CREATE OR REPLACE FUNCTION my_manager_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM managers WHERE user_id = auth.uid();
$$;

-- League data: visible to members
CREATE POLICY leagues_read  ON leagues  FOR SELECT USING (id IN (SELECT my_league_ids()));
CREATE POLICY managers_read ON managers FOR SELECT USING (league_id IN (SELECT my_league_ids()));
CREATE POLICY managers_update_own ON managers FOR UPDATE
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Reference data: any authenticated user (single-tenant friendly)
CREATE POLICY players_read    ON players          FOR SELECT TO authenticated USING (true);
CREATE POLICY teams_read      ON tournament_teams FOR SELECT TO authenticated USING (true);
CREATE POLICY matchdays_read  ON matchdays        FOR SELECT USING (league_id IN (SELECT my_league_ids()));
CREATE POLICY fixtures_read   ON fixtures         FOR SELECT USING (league_id IN (SELECT my_league_ids()));
CREATE POLICY windows_read    ON transfer_windows FOR SELECT USING (league_id IN (SELECT my_league_ids()));

-- Draft: league-visible reads; writes only via functions
CREATE POLICY draft_state_read ON draft_state FOR SELECT USING (league_id IN (SELECT my_league_ids()));
CREATE POLICY draft_picks_read ON draft_picks FOR SELECT USING (league_id IN (SELECT my_league_ids()));

-- Queues: private to owner
CREATE POLICY pick_queue_own ON pick_queues FOR ALL
  USING (manager_id IN (SELECT my_manager_ids()))
  WITH CHECK (manager_id IN (SELECT my_manager_ids()));

-- Rosters: league-visible (needed for free-agent + ownership views); no client writes
CREATE POLICY rosters_read ON rosters FOR SELECT USING (
  manager_id IN (SELECT id FROM managers WHERE league_id IN (SELECT my_league_ids()))
);

-- Lineups: own always; others' once the matchday has locked
CREATE POLICY lineups_read ON lineups FOR SELECT USING (
  manager_id IN (SELECT my_manager_ids())
  OR EXISTS (SELECT 1 FROM matchdays md WHERE md.id = matchday_id AND md.lock_at <= now())
);

-- Transfers: league-visible reads; writes via make_transfer()
CREATE POLICY transfers_read ON transfers FOR SELECT USING (
  manager_id IN (SELECT id FROM managers WHERE league_id IN (SELECT my_league_ids()))
);

-- Scoring: league-visible reads only
CREATE POLICY events_read       ON player_events FOR SELECT TO authenticated USING (true);
CREATE POLICY match_scores_read ON match_scores  FOR SELECT TO authenticated USING (true);
CREATE POLICY standings_read    ON standings     FOR SELECT USING (
  manager_id IN (SELECT id FROM managers WHERE league_id IN (SELECT my_league_ids()))
);
-- NOTE: no write policy on standings. v1's `USING (true)` is the bug this replaces.

-- Watchlist: private
CREATE POLICY player_notes_own ON player_notes FOR ALL
  USING (manager_id IN (SELECT my_manager_ids()))
  WITH CHECK (manager_id IN (SELECT my_manager_ids()));

-- allowed_emails: commissioner-managed
CREATE POLICY allowed_emails_commissioner ON allowed_emails FOR ALL USING (
  league_id IN (SELECT league_id FROM managers WHERE user_id = auth.uid() AND is_commissioner)
);
