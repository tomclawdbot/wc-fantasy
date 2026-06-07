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

  if (!draft) {
    return json({ message: 'No active draft', processed: false });
  }

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
    await advanceDraft(db, draft);
    return json({ message: 'Already picked, advancing', processed: true });
  }

  // Get best available player (lowest ranking = best) not yet drafted
  const { data: draftedIds } = await db.from('draft_picks').select('player_id');
  const drafted = new Set((draftedIds ?? []).map((p: any) => p.player_id));

  const { data: available } = await db
    .from('players')
    .select('id, name, position, nation, ranking')
    .not('id', 'in', `(${Array.from(drafted).map((s: string) => `'${s}'`).join(',')})`)
    .order('ranking')
    .limit(5);

  if (!available || available.length === 0) {
    return json({ message: 'No players available', processed: false });
  }

  const player = available[0];

  // Make the pick using the RPC (only takes player_id)
  const { error: pickErr } = await db.rpc('make_pick', {
    p_player_id: player.id,
  });

  if (pickErr) {
    return json({ error: pickErr.message }, 500);
  }

  // Advance draft to next manager
  await advanceDraft(db, draft);

  return json({
    ok: true,
    pick_no: current_pick_no,
    player: player.name,
    position: player.position,
    processed: true,
  });
});

async function advanceDraft(db: any, draft: any) {
  const { current_pick_no, round_no } = draft;
  const NUM_MANAGERS = 10;
  const NEXT_PICK = current_pick_no + 1;
  const NEXT_ROUND = Math.ceil(NEXT_PICK / NUM_MANAGERS) || 1;

  // Snake draft: odd rounds go 1→10, even rounds go 10→1
  const pickInRound = ((NEXT_PICK - 1) % NUM_MANAGERS) + 1;
  let nextSlot: number;
  if (NEXT_ROUND % 2 === 1) {
    nextSlot = pickInRound;
  } else {
    nextSlot = NUM_MANAGERS - pickInRound + 1;
  }

  // Get manager ID for next slot
  const { data: nextManager } = await db
    .from('managers')
    .select('id')
    .eq('draft_slot', nextSlot)
    .single();

  if (!nextManager) {
    // Draft complete
    await db.from('draft_state').update({ status: 'complete' }).eq('id', draft.id);
    return;
  }

  // Set deadline to 75 seconds from now
  const deadline = new Date(Date.now() + 75 * 1000).toISOString();

  await db
    .from('draft_state')
    .update({
      current_pick_no: NEXT_PICK,
      round_no: NEXT_ROUND,
      current_manager_id: nextManager.id,
      pick_deadline: deadline,
    })
    .eq('id', draft.id);
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}