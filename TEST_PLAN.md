# WC Fantasy League — End-to-End Test Plan
**Version 1.0 | WC Fantasy Build | June 2026**

---

## 1. Testing Philosophy

- **Test the live draft above all else.** It's the hardest feature and the most critical. Everything else is CRUD.
- **E2E tests use Playwright** simulating real browser users (10 simultaneous managers).
- **Unit tests use Vitest** for pure logic (snake order, scoring math, quota validation).
- **Integration tests** for Supabase Edge Functions (RPC calls with real DB).
- **All tests are deterministic** — no flaky timing tests that pass on re-run.

---

## 2. Test Environments

| Environment | Purpose | URL |
|-------------|---------|-----|
| Local dev | Frontend + Supabase local emulators | `localhost:5173` + `localhost:54321` |
| Staging | Deployed frontend + Supabase staging DB | `wc-fantasy-staging.vercel.app` |
| Production | Live league data | `wc-fantasy.vercel.app` |

**Rule:** Test locally first. Staging for integration. Production only for final sign-off.

---

## 3. E2E Testing Stack

- **Playwright** — browser automation for E2E
- **Supabase CLI** — local emulator for DB testing
- **msw (Mock Service Worker)** — mock API-Football responses for scoring/import tests
- **Vitest** — unit + integration tests

---

## 4. Test Scenarios

### 4.1 AUTH — Sign-Up and Access Control

| Test ID | Scenario | Steps | Expected Result |
|---------|----------|-------|-----------------|
| AUTH-01 | Invite flow | Commissioner generates invite link → manager clicks → magic link → account created | Manager lands on `/` with their name visible, correct permissions |
| AUTH-02 | Public sign-up blocked | Navigate to `/signup` or try POST to auth endpoint directly | 403 / redirect to invite-only page |
| AUTH-03 | Non-manager access | Try to access `/draft` or `/team` with non-manager account | Redirect to `/` or error — row-level security enforced |
| AUTH-04 | Commissioner rights | Log in as commissioner → access `start_draft()` | Draft begins; all managers see status change |
| AUTH-05 | Session expiry | Log in → wait for token expiry → refresh page | Redirected to login gracefully; no data loss |
| AUTH-06 | Concurrent login | Same manager account logged in from two browsers | Both sessions work; latest activity reflected |

---

### 4.2 LIVE SNAKE DRAFT

The draft is the critical path. These tests must all pass before any other feature is considered done.

| Test ID | Scenario | Steps | Expected Result |
|---------|----------|-------|-----------------|
| DRAFT-01 | Draft start | Commissioner clicks "Start Draft" | All 10 managers see draft board; random slot order displayed; pick timer starts for manager #1 |
| DRAFT-02 | Pick order — round 1 | All 10 managers make picks in order | Picks appear in slot order 1→10 within 2 seconds for all managers |
| DRAFT-03 | Pick order — round 2 | Round 2 begins | Order reverses: slot 10→1 |
| DRAFT-04 | Pick order — round 3 | Round 3 begins | Order restores to 1→10 |
| DRAFT-05 | Player removed from pool | Manager 1 picks a player | That player disappears from all 10 available-player lists simultaneously |
| DRAFT-06 | Duplicate pick blocked | Manager tries to pick same player from two browser tabs simultaneously | Only one succeeds; loser gets error "Player already drafted"; board refreshes |
| DRAFT-07 | Quota enforcement | Manager with 5 DEF already tries to pick a 6th DEF | Pick rejected with error "DEF quota exceeded"; player remains available |
| DRAFT-08 | Auto-pick from queue | Manager sets pick queue, then disconnects for 65s | Auto-pick fires; correct player from queue selected; logged as auto_pick=true |
| DRAFT-09 | Auto-pick fallback | Manager with empty queue disconnects for 65s | Highest-ranked available player auto-selected per quota |
| DRAFT-10 | Pick timer countdown | Manager is on the clock | Countdown visible to all 10 managers; reaches 0 → auto-pick fires |
| DRAFT-11 | Reconnection mid-draft | Manager drops and rejoins | Sees current draft_state snapshot immediately; subscriptions resume; queue still active |
| DRAFT-12 | Reconnection picks up state | Manager reconnects after missing 5 picks | Board shows all 5 picks; draft continues correctly |
| DRAFT-13 | Draft completes | All 150 picks made | Status=complete; all managers see final rosters; league moves to team management phase |
| DRAFT-14 | 10-simulated-clients full draft | Playwright launches 10 browser contexts simultaneously; all join draft; all pick with zero think time | Draft completes in correct snake order; no race conditions; no duplicate picks |

**DRAFT-14 is the gatekeeper test.** If it fails, the draft is not production-ready.

---

### 4.3 LINEUP MANAGEMENT

| Test ID | Scenario | Steps | Expected Result |
|---------|----------|-------|-----------------|
| LINEUP-01 | Valid XI set | Manager sets 1 GK, 3 DEF, 3 MID, 4 FWD before lock | Lineup accepted; confirmation shown |
| LINEUP-02 | Invalid formation — too few DEF | Manager submits XI with 2 DEF | Rejected with "Minimum 3 DEF required" |
| LINEUP-03 | Invalid formation — player not in roster | Manager submits XI including undrafted player | Rejected with "Player not in your roster" |
| LINEUP-04 | Lineup locked after kickoff | Manager tries to change XI after lock time | Rejected with "Lineup locked for this round" |
| LINEUP-05 | XI auto-saved | Manager sets lineup, closes browser, reopens | Same XI persisted |
| LINEUP-06 | Manager from eliminated nation | All 11 starters from a nation that is out | Players score 0; lineup cannot be changed to include non-existent rounds |

---

### 4.4 TRANSFERS

| Test ID | Scenario | Steps | Expected Result |
|---------|----------|-------|-----------------|
| TRANS-01 | Valid transfer | Open window; swap a drafted DEF for a free-agent DEF | Transfer accepted; roster updated; out-player returned to pool |
| TRANS-02 | Transfer out of window | Manager tries transfer outside open window | Rejected with "Transfer window closed" |
| TRANS-03 | Free count exceeded | Manager uses all transfers, then tries another | Rejected with "No transfers remaining" |
| TRANS-04 | Transfer non-free-agent | Manager tries to claim a player already owned by another manager | Rejected with "Player already drafted" |
| TRANS-05 | Quota broken by transfer | Transfer would result in 6 DEF (exceeds 5 DEF cap) | Rejected with "DEF quota exceeded" |
| TRANS-06 | Waiver — reverse standings priority | Two managers claim same free agent simultaneously | Manager in lower standings gets priority |
| TRANS-07 | Transfer window display | Manager views `/transfers` | Only open windows shown; future windows show countdown |

---

### 4.5 SCORING

| Test ID | Scenario | Steps | Expected Result |
|---------|----------|-------|-----------------|
| SCORE-01 | Goal scored | Mock API-Football event: player X scores; run import | Player X gets points per scoring table; standings update |
| SCORE-02 | Assist credited | Mock event: player Y gets assist | Points awarded; correct breakdown JSON stored |
| SCORE-03 | Clean sheet GK | Match ends 2-0; GK had clean sheet | Points awarded including clean sheet bonus |
| SCORE-04 | Card (yellow/red) | Mock event: player Z gets yellow card | Points deducted per scoring table |
| SCORE-05 | Player not in lineup scores | Player scores but is not in manager's XI | Manager receives 0 points for that player that round |
| SCORE-06 | Idempotent import | Run import_events twice for same match | Standings identical both times; no duplicate points |
| SCORE-07 | Knockout bonus multiplier | Player scores in Round of 16 | Points multiplied by knockout bonus |
| SCORE-08 | Eliminated nation scores zero | Player from eliminated nation has match event imported | Points = 0 regardless of event |
| SCORE-09 | Manually edit event | Commissioner manually edits a player_event (e.g., corrects assist) | Running recompute_standings reflects the correction |

---

### 4.6 STANDINGS

| Test ID | Scenario | Steps | Expected Result |
|---------|----------|-------|-----------------|
| STAND-01 | Live standings update | After import_events | Standings table reflects new points; ordered correctly |
| STAND-02 | Per-phase breakdown | Manager views standings | Phase-by-phase points visible; cumulative total accurate |
| STAND-03 | Reconnection shows current standings | Manager reconnects mid-tournament | Current standings with all scored rounds |
| STAND-04 | Commissioner view | Commissioner sees all managers' full standings | No差异 from manager view |

---

### 4.7 DATA IMPORT

| Test ID | Scenario | Steps | Expected Result |
|---------|----------|-------|-----------------|
| IMPORT-01 | Squad import | Commissioner triggers import_squads | All players from API-Football upserted; count matches API |
| IMPORT-02 | Withdrawal flagged | Player removed from API-Football squad | Player status=withdrawn; flagged for commissioner review |
| IMPORT-03 | Pool locked during draft | Commissioner tries to trigger import while draft in_progress | Rejected with "Pool locked during draft" |
| IMPORT-04 | Event import rate limit | Import runs during active match | Respects API-Football free tier limits; no 429 errors |
| IMPORT-05 | Import during match window | Match in progress; import_events runs | Events processed; points updated within 5 minutes of kickoff |

---

## 5. Test Execution Plan

### Phase 1: Local Emulator Testing (This is how we test during build)
```bash
# Start Supabase local emulator
supabase start

# Run unit tests (Vitest)
npm run test:unit

# Run E2E tests against local emulator (Playwright)
npm run test:e2e -- --project=chromium
```

### Phase 2: Staging Deployment
```bash
# Deploy to Vercel staging
npm run deploy:staging

# Run full Playwright suite against staging
npm run test:e2e -- --project=chromium --environment=staging
```

### Phase 3: Production Smoke Test (post-deploy)
```bash
# Run only the critical-path tests against production
npm run test:e2e -- --project=chromium --environment=production --tag=critical
```

---

## 6. CI/CD Integration

Every PR and merge to `main` must pass:

```
1. npm run test:unit          → Vitest unit tests
2. npm run test:e2e -- --project=chromium  → Playwright against local emulator
3. npm run build              → Vite build
4. npm run lint              → ESLint
```

Staging auto-deploys on merge to `main` if all checks pass. Production requires manual promotion from staging.

---

## 7. Test Data Strategy

### Seed Data
Pre-build seed script creates:
- 10 manager accounts (test passwords stored in `.env.test`)
- 1 commissioner account
- 100 mock players (10 per position × 10 nations) for local draft testing
- 5 matchday fixtures with pre-seeded events for scoring tests

### Mock API-Football
Use **msw** (Mock Service Worker) to intercept API-Football calls in tests:
- Mock squad data (confirmed players with positions/nations)
- Mock fixtures and kickoff times
- Mock player events (goals, assists, cards, clean sheets)
- Ensures tests run without real API keys

### Scoring Data
Seed match_scores directly for standing tests:
```sql
INSERT INTO match_scores (player_id, fixture_id, points, breakdown)
VALUES (player_1, fixture_md1_1, 8, '{"goal":1,"clean_sheet":1}');
```

---

## 8. Test Reporting

Playwright generates HTML reports at `playwright-report/index.html` after each run. Upload to Vercel Blob storage on CI failure so team can view without local Playwright setup.

Critical failures (DRAFT-01 through DRAFT-14) send a Slack notification to the build channel.

---

## 9. Performance Benchmarks

| Metric | Target |
|--------|--------|
| Draft board update latency | <2s for all 10 clients after a pick |
| Standings recompute time | <5s for full tournament recalc |
| Client page load (LCP) | <2.5s on 4G connection |
| API-Football import duration | <30s per scheduled run |
| Browser memory (10 clients) | <300MB per tab |

---

## 10. Testing Tools Setup

```bash
# Install dependencies
npm install -D @playwright/test vitest @vitest/ui msw
npx playwright install chromium --with-deps

# Run tests
npm run test          # all: unit + e2e
npm run test:unit     # vitest only
npm run test:e2e      # playwright only
npm run test:e2e -- --ui  # interactive playwright UI

# Key Playwright config flags
--project=chromium    # browser to use
--environment=local   # local|staing|production
--tag=critical       # only run critical-tagged tests
--reporter=list       # human-readable output
--timeout=30000       # per-test timeout
```

---

## 11. Definition of Done Per Feature

| Feature | Done When |
|---------|-----------|
| Live Draft | DRAFT-01 through DRAFT-14 all pass with 10 simulated clients |
| Scoring | SCORE-01 through SCORE-09 pass; import_events is idempotent |
| Transfers | TRANS-01 through TRANS-07 pass |
| Lineups | LINEUP-01 through LINEUP-06 pass |
| Auth | AUTH-01 through AUTH-06 pass |
| Standings | STAND-01 through STAND-04 pass |

**No feature is done until its E2E tests pass.**