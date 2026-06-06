import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SCORING = {
  appearance: 2,
  goal: { GK: 6, DEF: 5, MID: 4, FWD: 3 },
  assist: 3,
  cleanSheet: { GK: 5, DEF: 4, MID: 2 },
  save: 1,
  yellowCard: -1,
  redCard: -3,
  knockoutMultiplier: 1.5,
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const db = createClient(supabaseUrl, serviceKey);
  const apiKey = Deno.env.get('API_FOOTBALL_KEY');

  // Optionally: fetch new events from API-Football
  // For now: recompute scores from existing player_events
  // Idempotent: clears and rebuilds match_scores from player_events

  const { data: fixtures } = await db
    .from('fixtures')
    .select('id, phase, ext_fixture_id')
    .eq('status', 'finished');

  let processed = 0;

  for (const fixture of fixtures ?? []) {
    // Get all events for this fixture
    const { data: events } = await db
      .from('player_events')
      .select('*, players(position)')
      .eq('fixture_id', fixture.id);

    // Group by player
    const byPlayer: Record<string, any[]> = {};
    for (const ev of events ?? []) {
      const pid = ev.player_id;
      if (!byPlayer[pid]) byPlayer[pid] = [];
      byPlayer[pid].push(ev);
    }

    // Compute score per player
    for (const [playerId, playerEvents] of Object.entries(byPlayer)) {
      const pos = (playerEvents[0] as any).players?.position ?? 'MID';
      const isKnockout = ['R32','R16','QF','SF','Final'].includes(fixture.phase);

      const breakdown: Record<string, any> = {};
      let points = 0;

      const eventTypes = playerEvents.map((e: any) => e.event_type);

      if (eventTypes.length > 0) {
        const goalCount = eventTypes.filter((t: string) => t === 'goal').length;
        if (goalCount > 0) {
          const pts = (SCORING.goal[pos] ?? 3) * goalCount;
          points += pts;
          breakdown.goal = { count: goalCount, pts };
        }
        const assistCount = eventTypes.filter((t: string) => t === 'assist').length;
        if (assistCount > 0) {
          points += SCORING.assist * assistCount;
          breakdown.assist = { count: assistCount, pts: SCORING.assist * assistCount };
        }
        const cleanSheet = eventTypes.includes('cleanSheet');
        if (cleanSheet && SCORING.cleanSheet[pos]) {
          points += SCORING.cleanSheet[pos]!;
          breakdown.cleanSheet = { count: 1, pts: SCORING.cleanSheet[pos] };
        }
        const saveCount = eventTypes.filter((t: string) => t === 'save').length;
        if (saveCount > 0) {
          points += SCORING.save * saveCount;
          breakdown.save = { count: saveCount, pts: SCORING.save * saveCount };
        }
        const yc = eventTypes.filter((t: string) => t === 'yellowCard').length;
        if (yc > 0) {
          points += SCORING.yellowCard * yc;
          breakdown.yellowCard = { count: yc, pts: SCORING.yellowCard * yc };
        }
        const rc = eventTypes.filter((t: string) => t === 'redCard').length;
        if (rc > 0) {
          points += SCORING.redCard * rc;
          breakdown.redCard = { count: rc, pts: SCORING.redCard * rc };
        }
        if (eventTypes.includes('appearance')) {
          points += SCORING.appearance;
          breakdown.appearance = { count: 1, pts: SCORING.appearance };
        }
        if (isKnockout) {
          points = Math.round(points * SCORING.knockoutMultiplier);
          breakdown.knockoutMultiplier = SCORING.knockoutMultiplier;
        }
        breakdown.total = points;
      }

      // Upsert match_scores (idempotent)
      await db.from('match_scores').upsert({
        player_id: playerId,
        fixture_id: fixture.id,
        points,
        breakdown,
      }, { onConflict: 'player_id,fixture_id' });

      processed++;
    }
  }

  // Recompute standings
  await recomputeStandings(db);

  return json({ ok: true, processed });
});

async function recomputeStandings(db: ReturnType<typeof createClient>) {
  // Aggregate total points per manager from match_scores
  const { data: scores } = await db
    .from('match_scores')
    .select('player_id, fixture_id, points, fixtures(phase), rosters(manager_id)')
    .gt('points', 0);

  const totals: Record<string, { total: number; byPhase: Record<string, number> }> = {};

  for (const s of scores ?? []) {
    const mId = (s as any).rosters?.manager_id;
    if (!mId) continue;
    if (!totals[mId]) totals[mId] = { total: 0, byPhase: {} };
    totals[mId].total += s.points;
    const phase = (s as any).fixtures?.phase ?? 'Unknown';
    totals[mId].byPhase[phase] = (totals[mId].byPhase[phase] ?? 0) + s.points;
  }

  for (const [managerId, data] of Object.entries(totals)) {
    await db.from('standings').upsert({
      manager_id: managerId,
      total_points: data.total,
      by_phase: data.byPhase,
    }, { onConflict: 'manager_id' });
  }
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}