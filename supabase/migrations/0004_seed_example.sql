-- ════════════════════════════════════════════════════════════════
-- tournament-fantasy 0004_seed_example
-- ONE file to edit per tournament. Everything below is data, not code.
-- Copy, change the values, run. Nothing else in the repo needs touching
-- for Euro 2028, Copa América, AFCON, etc.
-- ════════════════════════════════════════════════════════════════

WITH league AS (
  INSERT INTO leagues (name, config) VALUES (
    'World Cup Fantasy 2026',
    '{
      "draft":  { "timer_seconds": 60 },
      "squad":  { "size": 15, "quota": { "GK": 2, "DEF": 5, "MID": 5, "FWD": 3 } },
      "lineup": { "size": 11,
                  "min": { "GK": 1, "DEF": 3, "MID": 2, "FWD": 1 },
                  "max": { "GK": 1, "DEF": 5, "MID": 5, "FWD": 3 } },
      "scoring": {
        "appearance": 2,
        "goal":   { "GK": 8, "DEF": 8, "MID": 8, "FWD": 8 },
        "assist": 4,
        "clean_sheet": { "GK": 4, "DEF": 4, "MID": 2, "FWD": 0 },
        "save": 1,
        "yellow_card": -1,
        "second_yellow": -3,
        "red_card": -3,
        "own_goal": -4,
        "penalty_missed": -2,
        "penalty_saved": 4
      },
      "phases": [
        { "key": "MD1",   "label": "Matchday 1",  "type": "group",    "multiplier": 1 },
        { "key": "MD2",   "label": "Matchday 2",  "type": "group",    "multiplier": 1 },
        { "key": "MD3",   "label": "Matchday 3",  "type": "group",    "multiplier": 1 },
        { "key": "R32",   "label": "Round of 32", "type": "knockout", "multiplier": 2 },
        { "key": "R16",   "label": "Round of 16", "type": "knockout", "multiplier": 2 },
        { "key": "QF",    "label": "Quarter-finals", "type": "knockout", "multiplier": 2 },
        { "key": "SF",    "label": "Semi-finals", "type": "knockout", "multiplier": 2 },
        { "key": "Final", "label": "Final",       "type": "knockout", "multiplier": 2 }
      ],
      "data_source": { "provider": "api-football", "league_id": 1, "season": 2026 }
    }'::jsonb
  ) RETURNING id
),
-- Manager shells: 10 slots, claimed via claim_manager_slot() + allowed_emails.
mgrs AS (
  INSERT INTO managers (league_id, display_name, draft_slot)
  SELECT league.id, 'Manager ' || s, s FROM league, generate_series(1, 10) s
  RETURNING league_id
),
-- Matchdays: lock_at = first kickoff of each round (edit per tournament).
mds AS (
  INSERT INTO matchdays (league_id, phase, label, lock_at)
  SELECT l.id, v.phase, v.label, v.lock_at::timestamptz
  FROM league l, (VALUES
    ('MD1',   'Matchday 1',     '2026-06-11 19:00+00'),
    ('MD2',   'Matchday 2',     '2026-06-18 16:00+00'),
    ('MD3',   'Matchday 3',     '2026-06-24 16:00+00'),
    ('R32',   'Round of 32',    '2026-06-28 16:00+00'),
    ('R16',   'Round of 16',    '2026-07-04 16:00+00'),
    ('QF',    'Quarter-finals', '2026-07-09 16:00+00'),
    ('SF',    'Semi-finals',    '2026-07-14 19:00+00'),
    ('Final', 'Final',          '2026-07-19 19:00+00')
  ) AS v(phase, label, lock_at)
  RETURNING league_id
)
-- Transfer windows between phases.
INSERT INTO transfer_windows (league_id, phase, opens_at, closes_at, free_count)
SELECT l.id, v.phase, v.opens_at::timestamptz, v.closes_at::timestamptz, v.free_count
FROM league l, (VALUES
  ('post-MD1', '2026-06-17 00:00+00', '2026-06-18 15:00+00', 1),
  ('post-MD2', '2026-06-23 00:00+00', '2026-06-24 15:00+00', 1),
  ('pre-R32',  '2026-06-27 00:00+00', '2026-06-28 15:00+00', 2),
  ('pre-R16',  '2026-07-02 00:00+00', '2026-07-04 15:00+00', 2),
  ('pre-QF',   '2026-07-07 00:00+00', '2026-07-09 15:00+00', 2),
  ('pre-SF',   '2026-07-12 00:00+00', '2026-07-14 18:00+00', 2),
  ('pre-Final','2026-07-16 00:00+00', '2026-07-19 18:00+00', 2)
) AS v(phase, opens_at, closes_at, free_count);

-- After seeding:
--   1. INSERT INTO allowed_emails (league_id, email, display_name) VALUES ...
--   2. Set commissioner: UPDATE managers SET is_commissioner = true WHERE ...;
--      UPDATE leagues SET commissioner_id = <that manager id>;
--   3. Run the import-squads and import-fixtures edge functions.
