import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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

  if (events.length === 0) {
    return json({ message: 'No events found', events_imported: 0 });
  }

  // Get fixture from DB
  const { data: fixture } = await db
    .from('fixtures')
    .select('id, phase')
    .eq('ext_fixture_id', String(ext_fixture_id))
    .single();

  const phase = fixture?.phase ?? 'group';
  const fixtureDbId = fixture?.id ?? null;

  // Event type mapping
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

  // Build player lookup maps
  const { data: allPlayers } = await db.from('players').select('id, name, ext_player_id');
  const extIdToDbId: Record<string, string> = {};
  const nameToDbId: Record<string, string> = {};
  for (const p of allPlayers ?? []) {
    if (p.ext_player_id) extIdToDbId[String(p.ext_player_id)] = p.id;
    nameToDbId[p.name.toLowerCase().trim()] = p.id;
  }

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

    // 1. Try ext_player_id lookup (most reliable)
    if (apiPlayerId && extIdToDbId[apiPlayerId]) {
      playerDbId = extIdToDbId[apiPlayerId];
    }

    // 2. Fallback: name exact match
    if (!playerDbId && playerName) {
      playerDbId = nameToDbId[playerName.toLowerCase().trim()] ?? '';
    }

    // 3. Fallback: last-name match
    if (!playerDbId && playerName) {
      const lastName = playerName.split(' ').pop()?.toLowerCase() ?? '';
      for (const [name, pid] of Object.entries(nameToDbId)) {
        if (name.endsWith(` ${lastName}`)) {
          playerDbId = pid;
          break;
        }
      }
    }

    if (!playerDbId) continue;

    const dedupKey = `${playerDbId}-${mappedType}-${minute}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    // Idempotent insert into player_events
    const { error } = await db.from('player_events').insert({
      player_id: playerDbId,
      fixture_id: fixtureDbId,
      ext_event_id: String(event.id ?? `${apiPlayerId}-${minute}`),
      event_type: mappedType,
      minute,
    });

    if (!error) imported++;
  }

  if (imported > 0 && fixtureDbId) {
    await computeAndUpdateStandings(db, fixtureDbId, phase);
  }

  return json({ ok: true, events_imported: imported, events_total: events.length });
});

async function computeAndUpdateStandings(db: any, fixtureId: string, phase: string) {
  // Read events that belong to this fixture (via ext_event_id pattern)
  // Use player_events filtered by fixture_id
  const { data: events } = await db
    .from('player_events')
    .select('player_id, event_type, minute')
    .eq('fixture_id', fixtureId);

  if (!events || events.length === 0) return;

  const { data: rosters } = await db
    .from('rosters')
    .select('manager_id, player_id')
    .eq('active', true);

  const playerMgrMap: Record<string, string> = {};
  for (const r of rosters ?? []) {
    playerMgrMap[r.player_id] = r.manager_id;
  }

  // Collect all (player, event, minute) → points, then upsert match_scores
  const matchScoreRows: Array<{
    player_id: string; fixture_id: string; points: number;
    breakdown: object; manager_id: string;
  }> = [];

  for (const event of events) {
    const pid = event.player_id;
    const managerId = playerMgrMap[pid];
    if (!managerId) continue;

    const { data: scoreData } = await db.rpc('compute_score', {
      p_player_id: pid,
      p_fixture_id: fixtureId,
      p_event_type: event.event_type,
      p_minute: event.minute,
      p_phase: phase,
    });
    const pts = scoreData ?? 0;

    matchScoreRows.push({
      player_id: pid,
      fixture_id: fixtureId,
      points: Number(pts),
      breakdown: { phase, minute: event.minute, event_type: event.event_type },
      manager_id: managerId,
    });
  }

  // Upsert match_scores (idempotent — ON CONFLICT DO UPDATE points)
  if (matchScoreRows.length > 0) {
    for (const row of matchScoreRows) {
      await db.from('match_scores').upsert({
        player_id: row.player_id,
        fixture_id: row.fixture_id,
        manager_id: row.manager_id,
        points: row.points,
        breakdown: row.breakdown,
      }, {
        onConflict: 'player_id,fixture_id',
      });
    }
  }

  // Update standings from match_scores totals (idempotent)
  const { data: scoreTotals } = await db
    .from('match_scores')
    .select('manager_id, points')
    .eq('fixture_id', fixtureId);

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

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}