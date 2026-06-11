// game-day — imports raw match data into player_events, then delegates ALL
// scoring to the database (rescore_fixture + recompute_standings).
// v1 had three diverging scoring tables (rules.ts, game-day SCORE const,
// compute_score SQL) and applied the knockout multiplier twice. v2 has one:
// score_event_points() in Postgres, reading leagues.config.scoring.
//
// Invoke: POST { "ext_fixture_id": "12345" }  (or omit to process every
// fixture currently in_progress / recently finished — cron mode)
import { serviceClient, json, corsHeaders, apiFootball } from '../_shared/lib.ts';

const EVENT_MAP: Record<string, string> = {
  'Normal Goal': 'Goal',
  'Penalty': 'Goal',
  'Own Goal': 'OwnGoal',
  'Yellow Card': 'YellowCard',
  'Second Yellow card': 'SecondYellow',
  'Red Card': 'RedCard',
  'Penalty Saved': 'PenaltySaved',
  'Missed Penalty': 'PenaltyMissed',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const db = serviceClient();
    const body = await req.json().catch(() => ({}));

    // Resolve fixtures to process
    let fixtureQuery = db.from('fixtures').select('id, league_id, ext_fixture_id, home_team, away_team, kickoff_at');
    if (body.ext_fixture_id) {
      fixtureQuery = fixtureQuery.eq('ext_fixture_id', String(body.ext_fixture_id));
    } else {
      // cron mode: anything kicked off in the last 4 hours and not cancelled
      const since = new Date(Date.now() - 4 * 3600_000).toISOString();
      fixtureQuery = fixtureQuery.gte('kickoff_at', since).lte('kickoff_at', new Date().toISOString())
        .neq('status', 'cancelled');
    }
    const { data: fixtures, error: fxErr } = await fixtureQuery;
    if (fxErr) return json({ error: fxErr.message }, 500);
    if (!fixtures?.length) return json({ message: 'No fixtures to process' });

    // ext_player_id → db id map (single fetch)
    const { data: players } = await db.from('players').select('id, name, ext_player_id');
    const byExtId = new Map<string, string>();
    const byName = new Map<string, string>();
    for (const p of players ?? []) {
      if (p.ext_player_id) byExtId.set(String(p.ext_player_id), p.id);
      byName.set(p.name.toLowerCase().trim(), p.id);
    }
    const resolvePlayer = (extId?: string, name?: string): string | null => {
      if (extId && byExtId.has(extId)) return byExtId.get(extId)!;
      if (name) return byName.get(name.toLowerCase().trim()) ?? null;
      return null;
    };

    const summary: unknown[] = [];
    const leagues = new Set<string>();

    for (const fx of fixtures) {
      const extId = fx.ext_fixture_id;
      const rows: Record<string, unknown>[] = [];

      // 1. discrete events (goals, assists, cards, penalties)
      const events = await apiFootball('fixtures/events', { fixture: extId });
      for (const ev of events) {
        const type = EVENT_MAP[ev.detail ?? ''] ?? (ev.type === 'Goal' ? EVENT_MAP[ev.detail] : undefined);
        const minute = ev.time?.elapsed ?? 0;
        if (type) {
          const pid = resolvePlayer(String(ev.player?.id ?? ''), ev.player?.name);
          if (pid) rows.push({
            player_id: pid, fixture_id: fx.id, event_type: type, qty: 1, minute,
            ext_event_id: `${extId}-${type}-${ev.player?.id}-${minute}`,
          });
        }
        // assists ride along on goal events
        if (ev.type === 'Goal' && ev.detail !== 'Own Goal' && ev.assist?.id) {
          const aid = resolvePlayer(String(ev.assist.id), ev.assist?.name);
          if (aid) rows.push({
            player_id: aid, fixture_id: fx.id, event_type: 'Assist', qty: 1, minute,
            ext_event_id: `${extId}-Assist-${ev.assist.id}-${minute}`,
          });
        }
      }

      // 2. per-player stats: appearances, saves, clean sheets
      const stats = await apiFootball('fixtures/players', { fixture: extId });
      const goalsAgainst: Record<string, number> = {};
      const teamNames = stats.map((t: any) => t.team?.name ?? '');
      for (const t of stats) {
        // goals conceded by team = goals scored by the other team
        const other = stats.find((o: any) => o.team?.id !== t.team?.id);
        goalsAgainst[t.team?.name ?? ''] =
          (other?.players ?? []).reduce((sum: number, p: any) =>
            sum + (p.statistics?.[0]?.goals?.total ?? 0), 0);
      }
      for (const t of stats) {
        const cleanSheet = (goalsAgainst[t.team?.name ?? ''] ?? 1) === 0;
        for (const p of t.players ?? []) {
          const pid = resolvePlayer(String(p.player?.id ?? ''), p.player?.name);
          if (!pid) continue;
          const s = p.statistics?.[0] ?? {};
          const minutes = s.games?.minutes ?? 0;
          if (minutes > 0) {
            rows.push({ player_id: pid, fixture_id: fx.id, event_type: 'Appearance', qty: 1, minute: minutes,
              ext_event_id: `${extId}-App-${p.player.id}` });
            if (cleanSheet && minutes >= 60) {
              rows.push({ player_id: pid, fixture_id: fx.id, event_type: 'CleanSheet', qty: 1, minute: minutes,
                ext_event_id: `${extId}-CS-${p.player.id}` });
            }
            const saves = s.goals?.saves ?? 0;
            if (saves > 0) {
              rows.push({ player_id: pid, fixture_id: fx.id, event_type: 'Save', qty: saves, minute: minutes,
                ext_event_id: `${extId}-Save-${p.player.id}` });
            }
          }
        }
      }

      // 3. idempotent rewrite of this fixture's raw events, then rescore
      await db.from('player_events').delete().eq('fixture_id', fx.id);
      if (rows.length) {
        const { error: insErr } = await db.from('player_events').insert(rows);
        if (insErr) { summary.push({ fixture: extId, error: insErr.message }); continue; }
      }
      const { data: rescored, error: rsErr } = await db.rpc('rescore_fixture', { p_fixture_id: fx.id });
      if (rsErr) { summary.push({ fixture: extId, error: rsErr.message }); continue; }
      leagues.add(fx.league_id);
      summary.push({ fixture: `${fx.home_team} v ${fx.away_team}`, events: rows.length, ...rescored });
    }

    for (const leagueId of leagues) {
      await db.rpc('recompute_standings', { p_league_id: leagueId });
    }
    return json({ ok: true, fixtures: summary });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
