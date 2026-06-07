import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ─── Scoring constants (SINGLE SOURCE OF TRUTH — also in import-events) ───
const SCORE = {
  appearance: 2,
  goal: { GK: 6, DEF: 5, MID: 4, FWD: 3 },
  assist: 3,
  cleanSheet: { GK: 5, DEF: 4, MID: 2 },
  save: 1,
  yellowCard: -1,
  redCard: -3,
  knockoutMultiplier: 1.5,
} as const;

// ─── game-day ──────────────────────────────────────────────────
// Imports match events from API-Football, scores them, updates match_scores + standings.
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const { ext_fixture_id } = await req.json();
  if (!ext_fixture_id) {
    return json({ error: 'ext_fixture_id required' }, 400);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const apiKey = Deno.env.get('API_FOOTBALL_KEY');
  if (!apiKey) return json({ error: 'API_FOOTBALL_KEY env not set' }, 500);

  const db = createClient(supabaseUrl, serviceKey);

  // Fetch events from API-Football
  const eventsResp = await fetch(
    `https://v3.football.api-sports.io/fixtures/events?fixture=${ext_fixture_id}`,
    { headers: { 'x-apisports-key': apiKey } }
  );
  const eventsData = await eventsResp.json();
  const events: any[] = eventsData.response ?? [];

  // Get fixture from DB
  const { data: fixture } = await db
    .from('fixtures')
    .select('id, phase')
    .eq('ext_fixture_id', String(ext_fixture_id))
    .single();

  const phase = fixture?.phase ?? 'group';
  const fixtureDbId = fixture?.id ?? null;
  const isKnockout = ['R32', 'R16', 'QF', 'SF', 'Final'].includes(phase);

  // Build player lookup
  const { data: allPlayers } = await db.from('players').select('id, name, position, ext_player_id');
  const extIdToDbId: Record<string, string> = {};
  const nameToDbId: Record<string, string> = {};
  for (const p of allPlayers ?? []) {
    if (p.ext_player_id) extIdToDbId[String(p.ext_player_id)] = p.id;
    nameToDbId[p.name.toLowerCase().trim()] = p.id;
  }

  // FIX #6: Fetch lineups for appearance events
  const lineupsResp = await fetch(
    `https://v3.football.api-sports.io/fixtures/lineups?fixture=${ext_fixture_id}`,
    { headers: { 'x-apisports-key': apiKey } }
  );
  const lineupsData = await lineupsResp.json();
  const lineups: any[] = lineupsData.response ?? [];

  // FIX #6: Fetch fixture stats for saves / goals conceded (clean sheet)
  const statsResp = await fetch(
    `https://v3.football.api-sports.io/fixtures/statistics?fixture=${ext_fixture_id}`,
    { headers: { 'x-apisports-key': apiKey } }
  );
  const statsData = await statsResp.json();

  // Determine which team kept a clean sheet
  const { homeScore, awayScore, homeTeamId, awayTeamId } = await getFixtureScore(ext_fixture_id, apiKey);

  const eventTypeMap: Record<string, string> = {
    'Goal': 'Goal',
    'Penalty': 'Goal',
    'Own Goal': 'OwnGoal',
    'Yellow Card': 'YellowCard',
    'Second Yellow': 'SecondYellow',
    'Red Card': 'RedCard',
    'Penalty Saved': 'PenaltySaved',
    'Missed Penalty': 'PenaltyMissed',
    'Substitution': 'Substitution',
  };

  // Import game events
  let imported = 0;
  const seen = new Set<string>();

  for (const event of events) {
    const detail = event.detail ?? '';
    const mappedType = eventTypeMap[detail];
    if (!mappedType) continue;

    const apiPlayerId = String(event.player?.id ?? '');
    const playerName = (event.player?.name ?? '').trim();
    const minute = event.time?.elapsed ?? 0;
    let playerDbId = '';

    if (apiPlayerId && extIdToDbId[apiPlayerId]) {
      playerDbId = extIdToDbId[apiPlayerId];
    } else if (playerName) {
      playerDbId = nameToDbId[playerName.toLowerCase().trim()] ?? '';
      if (!playerDbId) {
        const lastName = playerName.split(' ').pop()?.toLowerCase() ?? '';
        for (const [name, pid] of Object.entries(nameToDbId)) {
          if (name.endsWith(` ${lastName}`)) { playerDbId = pid as string; break; }
        }
      }
    }

    if (!playerDbId) continue;

    const dedupKey = `${playerDbId}-${mappedType}-${minute}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const { error } = await db.from('player_events').insert({
      player_id: playerDbId,
      fixture_id: fixtureDbId,
      ext_event_id: String(event.id ?? `${apiPlayerId}-${minute}`),
      event_type: mappedType,
      minute,
    });

    if (!error) imported++;
  }

  // FIX #6: Insert appearance events from lineups
  let appearancesImported = 0;
  const { data: rosters } = await db.from('rosters').select('manager_id, player_id, players(position, ext_player_id)').eq('active', true);

  const playerMgrMap: Record<string, string> = {};
  const playerPosMap: Record<string, string> = {};
  const extPlayerIdToDbId: Record<string, string> = {};
  for (const r of rosters ?? []) {
    const p = (r as any).players;
    if (p) {
      playerMgrMap[r.player_id] = r.manager_id;
      playerPosMap[r.player_id] = p.position;
      if (p.ext_player_id) extPlayerIdToDbId[String(p.ext_player_id)] = r.player_id;
    }
  }

  for (const team of lineups) {
    const teamName = team.team?.name ?? '';
    const started: string[] = [];
    const bench: string[] = [];

    for (const player of team.startXI ?? []) {
      const pid = extPlayerIdToDbId[String(player.player?.id ?? '')];
      if (pid) started.push(pid);
    }
    for (const player of team.bench ?? []) {
      const pid = extPlayerIdToDbId[String(player.player?.id ?? '')];
      if (pid) bench.push(pid);
    }

    // Determine clean sheet: team that conceded 0 goals
    const teamCleanSheet = (homeScore === 0 && teamName === homeTeamId) ||
                          (awayScore === 0 && teamName === awayTeamId);

    for (const pid of started) {
      const playerDbId = pid;
      const pos = playerPosMap[pid] ?? 'MID';

      // FIX #6: Score appearance
      const { error: appErr } = await db.from('player_events').insert({
        player_id: playerDbId,
        fixture_id: fixtureDbId,
        ext_event_id: `app-${pid}-${ext_fixture_id}`,
        event_type: 'Appearance',
        minute: 0,
      });
      if (!appErr) appearancesImported++;

      // FIX #6: Score clean sheet for GK/DEF/MID
      if (teamCleanSheet && pos in SCORE.cleanSheet) {
        const dedupKey = `${pid}-CleanSheet-0`;
        if (!seen.has(dedupKey)) {
          seen.add(dedupKey);
          const { error: csErr } = await db.from('player_events').insert({
            player_id: playerDbId,
            fixture_id: fixtureDbId,
            ext_event_id: `cs-${pid}-${ext_fixture_id}`,
            event_type: 'CleanSheet',
            minute: 0,
          });
          if (!csErr) imported++;
        }
      }
    }

    // GK: score saves from fixture stats
    for (const pid of started) {
      const pos = playerPosMap[pid] ?? '';
      if (pos !== 'GK') continue;

      // Get saves from fixture statistics
      const teamStats = statsData.response?.find((s: any) => s.team?.name === teamName);
      const savesStr = teamStats?.statistics?.find((st: any) => st.type === 'Saves')?.value ?? '0';
      const saves = parseInt(String(savesStr), 10);

      if (saves > 0) {
        const dedupKey = `${pid}-Save-0`;
        if (!seen.has(dedupKey)) {
          seen.add(dedupKey);
          const { error: saveErr } = await db.from('player_events').insert({
            player_id: pid,
            fixture_id: fixtureDbId,
            ext_event_id: `sv-${pid}-${ext_fixture_id}`,
            event_type: 'Save',
            minute: 0,
          });
          if (!saveErr) {
            // Insert one Save event with count in minute field (for scoring)
            await db.from('player_events').insert({
              player_id: pid,
              fixture_id: fixtureDbId,
              ext_event_id: `sv-count-${pid}-${ext_fixture_id}`,
              event_type: 'SaveCount',
              minute: saves,
            });
            imported += 2;
          }
        }
      }
    }
  }

  // Score all player_events for this fixture
  if ((imported > 0 || appearancesImported > 0) && fixtureDbId) {
    await computeAndUpdateStandings(db, fixtureDbId, phase);
  }

  return json({
    ok: true,
    events_imported: imported,
    appearances_imported: appearancesImported,
    events_total: events.length,
  });
});

// ─── Scoring engine ─────────────────────────────────────────────
function computePoints(eventTypes: string[], pos: string, isKnockout: boolean): { points: number; breakdown: Record<string, any> } {
  let points = 0;
  const breakdown: Record<string, any> = {};

  const eventCounts: Record<string, number> = {};
  for (const t of eventTypes) eventCounts[t] = (eventCounts[t] ?? 0) + 1;

  // Appearance
  if (eventCounts['Appearance'] > 0 || eventCounts['Goal'] > 0 || eventCounts['SaveCount'] > 0) {
    const appCount = Math.min(eventCounts['Appearance'] ?? 0, 1);
    if (appCount > 0) {
      points += SCORE.appearance * appCount;
      breakdown.appearance = { count: appCount, pts: SCORE.appearance * appCount };
    }
  }

  // Goals
  const goalCount = eventCounts['Goal'] ?? 0;
  if (goalCount > 0) {
    const goalPts = (SCORE.goal[pos as keyof typeof SCORE.goal] ?? 3) * goalCount;
    points += goalPts;
    breakdown.goal = { count: goalCount, pts: goalPts };
  }

  // Assists
  const assistCount = eventCounts['Assist'] ?? 0;
  if (assistCount > 0) {
    points += SCORE.assist * assistCount;
    breakdown.assist = { count: assistCount, pts: SCORE.assist * assistCount };
  }

  // Clean sheet (GK/DEF/MID only)
  const cleanSheetCount = eventCounts['CleanSheet'] ?? 0;
  if (cleanSheetCount > 0 && pos in SCORE.cleanSheet) {
    const csPts = SCORE.cleanSheet[pos as keyof typeof SCORE.cleanSheet]! * cleanSheetCount;
    points += csPts;
    breakdown.cleanSheet = { count: cleanSheetCount, pts: csPts };
  }

  // Saves (stored as SaveCount with saves in minute field)
  const saveCount = eventCounts['SaveCount'] ?? 0;
  if (saveCount > 0) {
    // minute field holds the save count
    points += SCORE.save * saveCount;
    breakdown.save = { count: saveCount, pts: SCORE.save * saveCount };
  }

  // Yellow card
  const ycCount = eventCounts['YellowCard'] ?? 0;
  if (ycCount > 0) {
    points += SCORE.yellowCard * ycCount;
    breakdown.yellowCard = { count: ycCount, pts: SCORE.yellowCard * ycCount };
  }

  // Red card
  const rcCount = (eventCounts['RedCard'] ?? 0) + (eventCounts['SecondYellow'] ?? 0);
  if (rcCount > 0) {
    points += SCORE.redCard * rcCount;
    breakdown.redCard = { count: rcCount, pts: SCORE.redCard * rcCount };
  }

  // Knockout multiplier
  if (isKnockout && points !== 0) {
    const oldPoints = points;
    points = Math.round(points * SCORE.knockoutMultiplier);
    breakdown.knockoutMultiplier = SCORE.knockoutMultiplier;
    breakdown.knockoutPoints = points - oldPoints;
  }

  breakdown.total = points;
  return { points, breakdown };
}

// ─── Update standings ───────────────────────────────────────────
async function computeAndUpdateStandings(db: any, fixtureDbId: string, phase: string) {
  const { data: events } = await db
    .from('player_events')
    .select('player_id, event_type, minute')
    .eq('fixture_id', fixtureDbId);

  if (!events || events.length === 0) return;

  const { data: rosters } = await db
    .from('rosters')
    .select('manager_id, player_id, players(position)');

  const playerMgrMap: Record<string, string> = {};
  const playerPosMap: Record<string, string> = {};
  for (const r of rosters ?? []) {
    playerMgrMap[r.player_id] = r.manager_id;
    const pos = (r as any).players?.position ?? 'MID';
    playerPosMap[r.player_id] = pos;
  }

  // Group events by player
  const byPlayer: Record<string, string[]> = {};
  for (const ev of events) {
    if (!byPlayer[ev.player_id]) byPlayer[ev.player_id] = [];
    byPlayer[ev.player_id].push(ev.event_type);
  }

  const isKnockout = ['R32', 'R16', 'QF', 'SF', 'Final'].includes(phase);
  const scoreRows: Array<{
    player_id: string; fixture_id: string; points: number;
    breakdown: object; manager_id: string;
  }> = [];

  for (const [playerId, evTypes] of Object.entries(byPlayer)) {
    const managerId = playerMgrMap[playerId];
    if (!managerId) continue;

    const pos = playerPosMap[playerId] ?? 'MID';
    const { points, breakdown } = computePoints(evTypes, pos, isKnockout);

    // If Appearance was never inserted, default to 1 appearance if player had events
    if (!evTypes.includes('Appearance') && evTypes.length > 0) {
      breakdown.appearance = { count: 1, pts: SCORE.appearance, note: 'defaulted' };
    }

    scoreRows.push({ player_id: playerId, fixture_id: fixtureDbId, points, breakdown, manager_id: managerId });
  }

  // Upsert match_scores
  for (const row of scoreRows) {
    await db.from('match_scores').upsert({
      player_id: row.player_id,
      fixture_id: row.fixture_id,
      manager_id: row.manager_id,
      points: row.points,
      breakdown: row.breakdown,
    }, { onConflict: 'player_id,fixture_id' });
  }

  // Recompute standings from match_scores
  const { data: scoreTotals } = await db
    .from('match_scores')
    .select('manager_id, points')
    .eq('fixture_id', fixtureDbId);

  const managerPoints: Record<string, number> = {};
  for (const row of scoreTotals ?? []) {
    managerPoints[row.manager_id] = (managerPoints[row.manager_id] ?? 0) + Number(row.points);
  }

  for (const [managerId, roundPts] of Object.entries(managerPoints)) {
    const { data: existing } = await db
      .from('standings')
      .select('total_points, by_phase')
      .eq('manager_id', managerId)
      .single();

    let newByPhase: Record<string, number> = {};
    if (existing?.by_phase) newByPhase = { ...existing.by_phase };
    newByPhase[phase] = Math.round((newByPhase[phase] ?? 0) + roundPts);
    const total = Object.values(newByPhase).reduce((a, b) => a + b, 0);

    await db.from('standings').upsert({
      manager_id: managerId,
      total_points: total,
      by_phase: newByPhase,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'manager_id' });
  }
}

// ─── Helpers ────────────────────────────────────────────────────
async function getFixtureScore(extFixtureId: string, apiKey: string): Promise<{
  homeScore: number; awayScore: number; homeTeamId: string; awayTeamId: string;
}> {
  try {
    const resp = await fetch(
      `https://v3.football.api-sports.io/fixtures?id=${extFixtureId}`,
      { headers: { 'x-apisports-key': apiKey } }
    );
    const data = await resp.json();
    const fixture = data.response?.[0];
    if (!fixture) return { homeScore: -1, awayScore: -1, homeTeamId: '', awayTeamId: '' };
    const goals = fixture.goals ?? {};
    return {
      homeScore: parseInt(goals.home ?? -1, 10),
      awayScore: parseInt(goals.away ?? -1, 10),
      homeTeamId: fixture.teams?.home?.name ?? '',
      awayTeamId: fixture.teams?.away?.name ?? '',
    };
  } catch {
    return { homeScore: -1, awayScore: -1, homeTeamId: '', awayTeamId: '' };
  }
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}