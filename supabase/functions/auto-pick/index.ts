import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ─── auto_pick_due ─────────────────────────────────────────────
// Called by: cron job (schedule) or commissioner trigger
// Finds managers whose pick deadline has passed but they haven't picked
// Picks from their queue (or highest-ranked available if queue empty)
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const db = createClient(supabaseUrl, serviceKey);

  // Find draft in progress where deadline has passed
  const { data: drafts } = await db
    .from('draft_state')
    .select('*')
    .eq('status', 'in_progress');

  const results: string[] = [];

  for (const draft of drafts ?? []) {
    if (!draft.pick_deadline || new Date(draft.pick_deadline) >= new Date()) continue;

    // Deadline passed — auto-pick for current manager
    const { data: manager } = await db
      .from('managers')
      .select('*')
      .eq('id', draft.current_manager_id)
      .single();

    if (!manager) { results.push('No current manager'); continue; }

    // Get manager's queue
    const { data: queue } = await db
      .from('pick_queues')
      .select('player_id, players(position, status)')
      .eq('manager_id', manager.id)
      .order('rank', { ascending: true });

    let playerId: string | null = null;
    let auto = false;

    // Try queue first
    if (queue && queue.length > 0) {
      for (const q of queue) {
        const p = (q as any).players as { id: string; status: string } | null;
        if (p?.status === 'active') {
          playerId = p.id;
          auto = true;
          break;
        }
      }
    }

    // Fallback: highest-ranked available player
    if (!playerId) {
      // Get all drafted player IDs
      const { data: drafted } = await db
        .from('draft_picks')
        .select('player_id')
        .eq('league_id', draft.league_id);
      const draftedIds = drafted?.map(p => p.player_id) ?? [];

      const { data: available } = await db
        .from('players')
        .select('id')
        .eq('status', 'active')
        .not('id', 'in', `(${draftedIds.join(',') || 'null'})`)
        .order('ranking', { ascending: true })
        .limit(1);

      playerId = available?.[0]?.id ?? null;
      auto = true;
    }

    if (!playerId) { results.push(`No available player for pick ${draft.current_pick_no}`); continue; }

    // Insert auto-pick
    const { error: insertErr } = await db.from('draft_picks').insert({
      league_id: draft.league_id,
      pick_no: draft.current_pick_no,
      manager_id: manager.id,
      player_id: playerId,
      auto_pick: true,
    });

    if (insertErr && insertErr.code !== '23505') {
      results.push(`Error on pick ${draft.current_pick_no}: ${insertErr.message}`);
      continue;
    }

    // Create roster entry
    await db.from('rosters').upsert({
      manager_id: manager.id,
      player_id: playerId,
      acquired_via: 'draft',
      active: true,
    }, { onConflict: 'manager_id,player_id' });

    // Remove from queue
    await db.from('pick_queues').delete().eq('manager_id', manager.id).eq('player_id', playerId);

    // Advance draft
    await advanceDraftDb(db, draft);

    results.push(`Auto-pick: ${manager.display_name} → player ${playerId} (pick ${draft.current_pick_no})`);
  }

  return json({ ok: true, results });
});

async function advanceDraftDb(db: ReturnType<typeof createClient>, draft: any) {
  const nextPickNo = draft.current_pick_no + 1;
  if (nextPickNo > 150) {
    await db.from('draft_state').update({ status: 'complete', pick_deadline: null }).eq('league_id', draft.league_id);
    return;
  }
  const nextSlot = getCurrentSlot(nextPickNo);
  const { data: nextManager } = await db.from('managers').select('id').eq('league_id', draft.league_id).eq('draft_slot', nextSlot).single();
  const deadline = new Date(Date.now() + draft.timer_seconds * 1000).toISOString();
  await db.from('draft_state').update({
    current_pick_no: nextPickNo,
    round_no: Math.ceil(nextPickNo / 10),
    current_manager_id: nextManager?.id ?? null,
    pick_deadline: deadline,
  }).eq('league_id', draft.league_id);
}

function getCurrentSlot(pickNo: number): number {
  const round = Math.ceil(pickNo / 10);
  const pos = pickNo - (round - 1) * 10;
  return round % 2 === 1 ? pos : 11 - pos;
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}