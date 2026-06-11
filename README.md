# tournament-fantasy

Draft-based fantasy football for any knockout tournament (World Cup, Euros, Copa América, AFCON...). React + Vite frontend on Vercel, Supabase (Postgres + Realtime + Auth + Edge Functions) backend, API-Football data.

Rewrite of `wc-fantasy` v1. **Every tournament-specific rule lives in one place: `leagues.config` (JSONB), seeded from `supabase/migrations/0004_seed_example.sql`.** Spinning up a new tournament means editing that one file.

## Architecture

```
players ─┐
         ├─ draft (make_pick / auto_pick RPCs, snake order, realtime board)
managers ─┘        │
                   ▼
                rosters ── set_lineup RPC ──► lineups (per matchday)
                   │                              │
            make_transfer RPC               recompute_standings()
                   │                              ▲
player_events ──► rescore_fixture() ──► match_scores
(raw, from API)    (single scoring path; phase multiplier applied ONCE here)
```

Principles (unchanged from v1 SPEC, now actually enforced):
- Postgres is authoritative. All mutations go through `SECURITY DEFINER` RPCs that resolve the caller from `auth.uid()` — the client never passes a `manager_id` it could spoof.
- One scoring implementation: `score_event_points()` in SQL, reading `config.scoring`. No scoring math in TypeScript anywhere.
- Idempotent imports: `game-day` rewrites a fixture's raw events and calls `rescore_fixture`; re-running self-heals.

## What's fixed vs v1

| v1 bug | v2 fix |
|---|---|
| League UUID `1111...` hardcoded in every RPC | League resolved from the caller's manager row |
| 10 managers / 150 picks / 2-5-5-3 quotas hardcoded in SQL, TS, and edge fns | All from `leagues.config`; manager count from DB |
| Three diverging scoring tables (rules.ts, game-day, compute_score) | One: `score_event_points()` reading config |
| Knockout multiplier applied twice (match_scores ×2, then standings ×2 again = 4×) | Applied once, in `rescore_fixture` |
| Group-stage point bleed: MD1 lineups collected MD2/MD3 fixture points (phase-level join) | `fixtures.matchday_id` added; standings join on it |
| `set_lineup` accepted any XI if *one* player was in your roster; took `p_manager_id` (impersonation); no formation/lock checks | All players checked; caller-scoped; formation + lock from config |
| `make_transfer` ignored windows, free counts, and quotas | All three enforced |
| `standings` RLS: `FOR ALL USING (true)` — any user could rewrite the table | No write policy; service role only |
| `wc_nations` had RLS disabled | `tournament_teams` with RLS |
| Anyone signed in could insert themselves as a manager and pick a slot | `claim_manager_slot()` RPC gated by `allowed_emails` |
| `auto_pick` ignored the manager's queue | Queue first, ranking fallback |
| Real API key committed in `.env.example` | Removed — **rotate the old key** |

## New tournament runbook

1. **Supabase project**: create one, then run migrations in order:
   ```
   supabase link --project-ref <ref>
   supabase db push        # runs 0001–0004
   ```
2. **Edit `0004_seed_example.sql` before pushing** (or run a copy manually): league name, scoring, phases/multipliers, matchday `lock_at` dates, transfer windows, manager slot count, `data_source` (API-Football league id + season).
3. **Invites + commissioner**:
   ```sql
   INSERT INTO allowed_emails (league_id, email, display_name) VALUES (...);
   UPDATE managers SET is_commissioner = true WHERE draft_slot = 1;  -- or whoever
   ```
4. **Secrets** (Supabase dashboard → Edge Functions):
   `API_FOOTBALL_KEY` (service role + URL are injected automatically).
5. **Deploy functions + import data**:
   ```
   supabase functions deploy auto-pick game-day import-squads import-fixtures
   curl -X POST .../functions/v1/import-squads
   curl -X POST .../functions/v1/import-fixtures
   ```
6. **Cron** (SQL editor, pg_cron):
   ```sql
   select cron.schedule('auto-pick', '* * * * *',
     $$select net.http_post('https://<ref>.supabase.co/functions/v1/auto-pick',
       headers => '{"Authorization": "Bearer <service-role-key>"}'::jsonb)$$);
   select cron.schedule('game-day', '*/10 * * * *',
     $$select net.http_post('https://<ref>.supabase.co/functions/v1/game-day',
       headers => '{"Authorization": "Bearer <service-role-key>"}'::jsonb, body => '{}'::jsonb)$$);
   ```
7. **Frontend**: set `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` in Vercel, `vercel --prod`.

## Local dev

```
npm install
cp .env.example .env   # fill in values
npm run dev
```

## Repo layout

```
src/config/types.ts          LeagueConfig types (mirror of leagues.config)
src/lib/supabase.ts          data layer — all RPCs + reads
src/lib/rules.ts             pure config-driven pre-validation (display only)
src/pages/                   Draft / Team / Transfers / Players / Standings / Home
supabase/migrations/0001     schema (tournament-agnostic)
supabase/migrations/0002     RLS
supabase/migrations/0003     game functions (single scoring path)
supabase/migrations/0004     ★ per-tournament seed — the only file to edit
supabase/functions/          auto-pick, game-day, import-squads, import-fixtures
```

## Migrating the live WC2026 database

The v1 production DB (mid-tournament) should NOT be reset. A non-destructive delta is possible (replace functions, add `fixtures.matchday_id`, close RLS holes) — see issues table above for what it must cover. Apply only between matchdays, with a backup.
