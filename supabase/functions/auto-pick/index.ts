import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const db = createClient(supabaseUrl, serviceKey);

  // Get active draft state
  const { data: draft } = await db
    .from('draft_state')
    .select('*')
    .eq('status', 'in_progress')
    .single();

  if (!draft) return json({ message: 'No active draft', processed: false });

  const { current_pick_no, current_manager_id, round_no, pick_deadline } = draft;

  // If deadline hasn't passed, don't auto-pick yet
  if (pick_deadline && new Date(pick_deadline) > new Date()) {
    return json({ message: 'Deadline not passed', processed: false });
  }

  // Check if current manager already picked this round
  const { data: existingPick } = await db
    .from('draft_picks')
    .select('id')
    .eq('manager_id', current_manager_id)
    .eq('round_no', round_no)
    .single();

  if (existingPick) {
    // Already picked — advance to next pick
    await advanceDraft(db, draft);
    return json({ message: 'Already picked, advancing', processed: true });
  }

  // Get best available player (lowest ranking number = best)
  const { data: draftedIds } = await db
    .from('draft_picks')
    .select('player_id');

  let playerQuery = db
    .from('players')
    .select('id, name, ranking')
    .eq('status', 'active')
    .order('ranking', { ascending: true })
    .limit(1);

  if (draftedIds && draftedIds.length > 0) {
    const taken = draftedIds.map((p: any) => p.player_id);
    playerQuery = playerQuery.not('id', 'in', `(${taken.join(',')})`);
  }

  const { data: bestPlayer } = await playerQuery.single();

  if (!bestPlayer) {
    return json({ error: 'No available players' }, 400);
  }

  // Make the pick
  const { error: pickErr } = await db.from('draft_picks').insert({
    manager_id: current_manager_id,
    player_id: bestPlayer.id,
    pick_no: current_pick_no,
    round_no,
    league_id: draft.league_id,
  });

  // Also add to roster
  await db.from('rosters').insert({
    manager_id: current_manager_id,
    player_id: bestPlayer.id,
    acquired_via: 'auto',
    active: true,
  });

  // Advance draft
  await advanceDraft(db, draft);

  return json({
    ok: true,
    manager_id: current_manager_id,
    player_id: bestPlayer.id,
    player_name: bestPlayer.name,
    pick_no: current_pick_no,
  });
});

async function advanceDraft(db: any, draft: any) {
  const leagueId = draft.league_id;
  const currentPickNo = draft.current_pick_no;
  const currentRound = draft.round_no;
  const currentManager = draft.current_manager_id;

  // Get managers ordered by draft_slot
  const { data: managers } = await db
    .from('managers')
    .select('id, draft_slot')
    .order('draft_slot', { ascending: true });

  const maxSlot = managers.length;
  const currentSlot = managers.find((m: any) => m.id === currentManager)?.draft_slot ?? 1;

  // Determine next slot using snake draft logic
  let nextSlot: number;
  if (currentRound % 2 === 1) {
    // Forward: 1→2→3→...→10→1
    nextSlot = currentSlot >= maxSlot ? 1 : currentSlot + 1;
  } else {
    // Reverse: 10→9→8→...→1→10
    nextSlot = currentSlot <= 1 ? maxSlot : currentSlot - 1;
  }

  const nextManager = managers.find((m: any) => m.draft_slot === nextSlot)?.id ?? currentManager;

  // Check if draft is complete (30 picks = 3 rounds × 10 managers)
  if (currentPickNo >= 30) {
    await db.from('draft_state').update({ status: 'completed' }).eq('league_id', leagueId);
    return;
  }

  // Determine next round and deadline
  let nextRound = currentRound;
  let deadline: string;

  if (currentPickNo % 10 === 0) {
    nextRound = currentRound + 1;
    deadline = new Date(Date.now() + 60 * 1000).toISOString(); // 60s per new round
  } else {
    deadline = new Date(Date.now() + 60 * 1000).toISOString();
  }

  await db.from('draft_state')
    .update({
      current_pick_no: currentPickNo + 1,
      round_no: nextRound,
      current_manager_id: nextManager,
      pick_deadline: deadline,
    })
    .eq('league_id', leagueId);
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}