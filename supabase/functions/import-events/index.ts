import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ─── Scoring constants (SINGLE SOURCE — must match game-day/index.ts EXACTLY) ───
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

// ─── import-events ─────────────────────────────────────────────
// Idempotent: recomputes match_scores from existing player_events.
// Called by cron job to backfill/repair scores after game-day runs.
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const db = createClient(supabaseUrl, serviceKey);

  const { data: fixtures } = await db
    .from('fixtures')
    .select('id, phase, ext_fixture_id')
    .eq('status', 'finished');

  let processed = 0;

  for (const fixture of fixtures ?? []) {
    const isKnockout = ['R32', 'R16', 'QF', 'SF', 'Final'].includes(fixture.phase);

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

    for (const [playerId, playerEvents] of Object.entries(byPlayer)) {
      const pos = (playerEvents[0] as any).players?.position ?? 'MID';
      const breakdown: Record<string, any> = {};
      let points = 0;

      const eventTypes = playerEvents.map((e: any) => e.event_type);
      const eventCounts: Record<string, number> = {};
      for (const t of eventTypes) eventCounts[t] = (eventCounts[t] ?? 0) + 1;

      // Appearance
      if (eventCounts['Appearance'] > 0) {
        points += SCORE.appearance;
        breakdown.appearance = { count: 1, pts: SCORE.appearance };
      }

      // Goals
      const goalCount = eventCounts['Goal'] ?? 0;
      if (goalCount > 0) {
        const pts = (SCORE.goal[pos as keyof typeof SCORE.goal] ?? 3) * goalCount;
        points += pts;
        breakdown.goal = { count: goalCount, pts };
      }

      // Assists
      const assistCount = eventCounts['Assist'] ?? 0;
      if (assistCount > 0) {
        points += SCORE.assist * assistCount;
        breakdown.assist = { count: assistCount, pts: SCORE.assist * assistCount };
      }

      // Clean sheet
      const cleanSheetCount = eventCounts['CleanSheet'] ?? 0;
      if (cleanSheetCount > 0 && pos in SCORE.cleanSheet) {
        const pts = SCORE.cleanSheet[pos as keyof typeof SCORE.cleanSheet]!;
        points += pts;
        breakdown.cleanSheet = { count: 1, pts };
      }

      // Saves
      const saveCount = eventCounts['SaveCount'] ?? 0;
      if (saveCount > 0) {
        points += SCORE.save * saveCount;
        breakdown.save = { count: saveCount, pts: SCORE.save * saveCount };
      }

      // Yellow card
      const yc = eventCounts['YellowCard'] ?? 0;
      if (yc > 0) {
        points += SCORE.yellowCard * yc;
        breakdown.yellowCard = { count: yc, pts: SCORE.yellowCard * yc };
      }

      // Red card
      const rc = (eventCounts['RedCard'] ?? 0) + (eventCounts['SecondYellow'] ?? 0);
      if (rc > 0) {
        points += SCORE.redCard * rc;
        breakdown.redCard = { count: rc, pts: SCORE.redCard * rc };
      }

      // Knockout multiplier
      if (isKnockout && points !== 0) {
        const old = points;
        points = Math.round(points * SCORE.knockoutMultiplier);
        breakdown.knockoutMultiplier = SCORE.knockoutMultiplier;
        breakdown.knockoutBonus = points - old;
      }

      breakdown.total = points;

      // Upsert match_scores
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
    const phase = (s as any).fixtures?.phase ?? 'group';
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