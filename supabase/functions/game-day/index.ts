import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const API_FOOTBALL_KEY = '91fc33f112c3e00de11c9060d6c9de18';

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const { fixture_id, ext_fixture_id } = await req.json();

  if (!ext_fixture_id) {
    return json({ error: 'ext_fixture_id required' }, 400);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const db = createClient(supabaseUrl, serviceKey);

  // Fetch events from API-Football
  const eventsResp = await fetch(`https://v3.football.api-sports.io/fixtures/events?fixture=${ext_fixture_id}`, {
    headers: { 'x-apisports-key': API_FOOTBALL_KEY }
  });
  const eventsData = await eventsResp.json();
  const events = eventsData.response ?? [];

  if (events.length === 0) {
    return json({ message: 'No events found for this fixture', events_imported: 0 });
  }

  // Get fixture from DB to determine phase
  const { data: fixture } = await db
    .from('fixtures')
    .select('id, phase')
    .eq('ext_fixture_id', String(ext_fixture_id))
    .single();

  const phase = fixture?.phase ?? 'group';

  // Event type mapping
  const eventTypeMap: Record<string, string> = {
    'Goal': 'Goal',
    'Penalty': 'Goal',
    'OwnGoal': 'OwnGoal',
    'Yellow Card': 'YellowCard',
    'Second Yellow': 'SecondYellow',
    'Red Card': 'RedCard',
    'Penalty Saved': 'PenaltySaved',
    'Missed Penalty': 'PenaltyMissed',
  };

  let imported = 0;
  const playerIdCache: Record<string, string> = {};

  for (const event of events) {
    const detail = event.detail ?? event.type ?? '';
    const mappedType = eventTypeMap[detail] ?? null;
    if (!mappedType) continue;

    const playerName = event.player?.name ?? '';
    if (!playerName) continue;

    const extPlayerId = String(event.player?.id ?? '');
    const extEventId = String(event.id ?? '');
    const minute = event.time?.elapsed ?? 0;

    // Look up player in DB by ext_player_id
    if (!playerIdCache[extPlayerId]) {
      const { data: player } = await db
        .from('players')
        .select('id')
        .eq('ext_player_id', extPlayerId)
        .single();
      playerIdCache[extPlayerId] = player?.id ?? '';
    }

    const playerDbId = playerIdCache[extPlayerId];
    if (!playerDbId) continue;

    const { error } = await db.from('player_events').insert({
      player_id: playerDbId,
      fixture_id: fixture?.id ?? ext_fixture_id,
      ext_event_id: extEventId,
      event_type: mappedType,
      minute,
    });

    if (!error) imported++;
  }

  // Compute scores for all imported events and update standings
  await computeAndUpdateStandings(db, fixture?.id ?? ext_fixture_id, phase);

  return json({ ok: true, events_imported: imported });
});

async function computeAndUpdateStandings(db: any, fixtureId: string, phase: string) {
  // Get all player_events for this fixture
  const { data: events } = await db
    .from('player_events')
    .select('player_id, event_type, minute')
    .eq('fixture_id', fixtureId);

  if (!events || events.length === 0) return;

  // Get all managers with active rosters containing these players
  const { data: rosters } = await db
    .from('rosters')
    .select('manager_id, player_id')
    .eq('active', true);

  const managerPoints: Record<string, number> = {};

  for (const event of events) {
    // Check if any manager has this player in their roster
    for (const roster of rosters) {
      if (roster.player_id !== event.player_id) continue;

      const pts = computeScore(event.event_type, phase);
      managerPoints[roster.manager_id] = (managerPoints[roster.manager_id] ?? 0) + pts;
    }
  }

  // Upsert standings
  for (const [managerId, totalPts] of Object.entries(managerPoints)) {
    const { data: existing } = await db
      .from('standings')
      .select('total_points, by_phase')
      .eq('manager_id', managerId)
      .single();

    let newByPhase: Record<string, number> = {};
    if (existing?.by_phase) {
      newByPhase = { ...existing.by_phase };
    }
    newByPhase[phase] = (newByPhase[phase] ?? 0) + totalPts;

    const total = Object.values(newByPhase).reduce((a, b) => a + b, 0);

    await db.from('standings').upsert({
      manager_id: managerId,
      total_points: total,
      by_phase: newByPhase,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'manager_id' });
  }
}

function computeScore(eventType: string, phase: string): number {
  const knockout = ['knockout', 'round_of_16', 'quarter', 'semi', 'final'].includes(phase);
  const mult = knockout ? 2 : 1;

  switch (eventType) {
    case 'Goal': return 8 * mult;
    case 'Assist': return 4 * mult;
    case 'OwnGoal': return -4 * mult;
    case 'YellowCard': return -1 * mult;
    case 'SecondYellow': return -3 * mult;
    case 'RedCard': return -5 * mult;
    case 'PenaltySaved': return 4 * mult;
    case 'PenaltyMissed': return -3 * mult;
    default: return 0;
  }
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}