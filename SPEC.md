# WC Fantasy League — Project Specification
**Version 1.0 | Build for FIFA World Cup 2026 | 10-Manager Private League**

---

## 1. Overview

A live, draft-based fantasy game built around FIFA World Cup 2026.
- 10 managers run a real-time snake draft together
- Squads are built from official World Cup squad data (API-Football)
- Teams are managed across group stage + knockouts with transfers
- Points are scored from real match events (semi-automated updates)
- Single private league — built for reliability and low cost over scale

**Out of scope:** Payments, betting, native mobile apps, multiple concurrent leagues, real-time paid feeds.

---

## 2. Tech Stack

| Component | Technology |
|-----------|-------------|
| Frontend | React (Vite), responsive web |
| Backend | Supabase: Postgres + Realtime + Auth + Edge Functions |
| Data | API-Football (free tier) — squads, fixtures, match events |
| Hosting | Vercel (frontend) + Supabase Cloud (backend) |
| Testing | Playwright (E2E), Vitest (unit/integration) |

---

## 3. Data Model (Postgres)

### Core Tables

```
leagues          — single row: name, commissioner_id, config JSONB (scoring, quotas, timer, windows)
managers         — 10 rows: id, league_id, user_id, display_name, draft_slot 1-10
players          — id, ext_player_id, name, nation, club, position, status (active/withdrawn)
draft_state      — single row: status, current_pick_no, current_manager_id, round_no, pick_deadline
draft_picks      — append-only: pick_no, manager_id, player_id, auto_pick bool
                  UNIQUE(league_id, player_id) — prevents duplicate picks race-safe
pick_queues      — manager_id, player_id, rank (private wishlist; drives auto-pick)
rosters          — manager_id, player_id, acquired_via, active bool
matchdays        — phase, label, lock_at (per-round: MD1-3, R32, R16, QF, SF, Final)
lineups          — manager_id, matchday_id, player_id, slot (XI per matchday)
transfer_windows — phase, opens_at, closes_at, free_count
transfers        — manager_id, window_id, out_player_id, in_player_id
fixtures         — ext_fixture_id, phase, kickoff_at, status
player_events    — ext_fixture_id, player_id, type, minute (raw events from API)
match_scores     — player_id, fixture_id, points, breakdown JSONB
standings        — manager_id, total_points, by_phase JSONB
```

### Key Constraints (Server-Enforced)
- `UNIQUE(league_id, player_id)` on draft_picks → race-safe live draft
- Quota enforcement: pick rejected if it breaks positional quota or makes remaining quota unfillable
- Lock enforcement: lineup/transfer writes rejected once `now() >= lock_at` / `window.closes_at`
- Transfer validation: in_player must be free agent; out_player must belong to manager; quotas preserved

---

## 4. Features

### 4.1 Auth
- Supabase Auth with invite/magic-link for 10 known users
- No public sign-up
- Row-Level Security (RLS): managers read league-wide data; write only their own
- Commissioner role: `start_draft`, manual corrections, config changes

### 4.2 Live Snake Draft
- Snake order: round 1 → 10, round 2 → 10→1, etc.
- 15 players per squad: 2 GK, 5 DEF, 5 MID, 3 FWD
- 60s per pick (configurable), countdown visible to all
- Auto-pick from queue on timeout; falls back to highest-ranked available
- Live board updates via Supabase Realtime for all 10 clients within ~1-2s
- Reconnection: full snapshot on join + delta subscriptions

### 4.3 Squad Import
- API-Football → players table (upsert on ext_player_id)
- Commissioner triggers pre-draft; flags additions/withdrawals
- Pool locks at draft start; commissioner can void pre-draft picks

### 4.4 Lineup Management
- XI per matchday: 1 GK, ≥3 DEF, ≥2 MID, ≥1 FWD, 11 total
- Lineups lock at kickoff of manager's first fixture in round
- Server-side formation + lock enforcement

### 4.5 Transfers
- Open between phases: 1 free after MD1, 1 after MD2, 2 free each knockout round
- Waiver resolution: reverse standings order if simultaneous claims (optional)
- Must respect quotas and one-owner-per-player rule
- Optional tournament-wide cap on total transfers

### 4.6 Scoring
- Configurable scoring table in leagues.config
- Events: appearance, goal, assist, clean sheet, save, card
- Knockout bonus multiplier
- Only players in locked lineup score for that round
- Eliminated-nation players score zero

### 4.7 Data Import (Semi-Automated)
- Scheduled Edge Function polls fixtures during match windows
- Idempotent event imports (re-run recomputes deterministically)
- Re-computes match_scores and standings on each run
- Corrections: re-run self-heals; commissioner can manually edit player_events

### 4.8 Standings
- Live cumulative totals across all phases
- Per-phase breakdown in standings table
- Knockouts: cumulative points (no head-to-head bracket)

---

## 5. Server Functions (Supabase Edge Functions / Postgres RPC)

| Function | Purpose |
|----------|---------|
| `start_draft()` | Randomise draft slots, set status=in_progress, first picker + deadline. Commissioner only. |
| `make_pick(player_id)` | Validated pick by current manager; UNIQUE backstop; snake order; advances draft |
| `auto_pick_due()` | Scheduled; auto-picks overdue current pick from queue |
| `set_lineup(matchday_id, xi[])` | Upsert XI; validates formation + ownership + lock |
| `make_transfer(window_id, out_id, in_id)` | Validated transfer within open window |
| `import_squads()` | Squad upsert from API-Football |
| `import_events()` | Event import + scoring + standings recompute |
| `recompute_standings()` | Idempotent rebuild of standings from match_scores |

---

## 6. Build Sequence

1. **Scaffold** — React client + Supabase project; Auth + 10 manager rows; RLS baseline
2. **Data Model** — All tables, constraints, leagues.config seed
3. **Live Draft** — draft_state machine, make_pick RPC, snake order, realtime, draft-room UI, auto-pick
4. **Team Management** — set_lineup with formation + lock; lineup UI
5. **Transfers** — transfer_windows + make_transfer; transfer UI
6. **Data Import + Scoring** — import_squads, import_events, scoring, standings UI
7. **Hardening** — Reconnection, rate-limit backoff, commissioner tools, idempotency tests

---

## 7. Architecture Principles

- **Single source of truth:** Postgres is authoritative; clients never hold authoritative state
- **Server-enforced rules:** Pick legality, quotas, ownership, locks enforced in DB/server functions
- **Realtime by subscription:** Supabase Realtime Postgres Changes; draft board is event-driven
- **Low cost:** Free tiers sufficient for 10 users
- **Idempotent imports:** Re-running scoring recomputes deterministically

---

## 8. Client Routes

- `/` — Landing / league overview
- `/draft` — Live draft room (WebSocket-driven)
- `/team` — Roster management + lineup setter
- `/transfers` — Transfer market + free agents
- `/standings` — Live standings table
- `/login` — Magic link invite flow
---

## Player Media (2026-06-07)

All active roster players are enriched with visual metadata fetched from API-Football and flagcdn.com.

### Columns
| Column | Source | Coverage |
|--------|--------|----------|
| `photo_url` | API-Football player photos (v3.football.api-sports.io/players) | 84/151 roster players (56%) |
| `nation_flag_url` | API-Football team logo (national team badge) or flagcdn.com | 151/151 roster players (100%) |
| `club_name` | API-Football player statistics (team.name) via league search | 130/151 roster players (86%) |
| `club_logo_url` | API-Football teams endpoint (team logo from club lookup by name) | 130/151 roster players (86%) |

### Data sourcing approach
- **Nation flags**: Team logos from `GET /teams?season=2026&league=1` for all 48 WC nations. Flagcdn.com fallback for nations not in API (e.g., Nigeria→ng.png, Slovenia→si.png).
- **Player photos**: Scanned all players in PL (league 39), La Liga (140), Serie A (135), Bundesliga (78), Ligue 1 (61) for seasons 2023–2024. Name normalized (strip spaces/punctuation) for matching.
- **Club logos**: Searched clubs by player surname across 5 leagues. Club logo from `GET /teams?search={club}`.
- **Known mismatches fixed**: Kevin De Bruyne (was Napoli→Man City), Bernardo Silva→Man City, Kylian Mbappé→Real Madrid, Sadio Mane (was Sporting→Al-Ettifaq), etc.

### Limitations
- 67 roster players still without photos (reserved bench players with common names that don't match cleanly)
- Some club assignments may be slightly off (surname matching is approximate)
- Non-top-5-league clubs may not resolve (e.g., Saudi, Turkish, Portuguese clubs)
