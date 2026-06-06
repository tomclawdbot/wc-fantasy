import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ─── start_draft ────────────────────────────────────────────────
/**
 * Commissioner starts the draft:
 * 1. Randomise draft_slot order for all 10 managers
 * 2. Set draft_state.status = 'in_progress'
 * 3. Set first pick deadline (now + 60s)
 * 4. Set current_pick_no = 1, round_no = 1, current_manager = slot 1
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const db = createClient(supabaseUrl, serviceKey);

    // Get authenticated user from header
    const token = req.headers.get('Authorization')?.replace('Bearer ', '');
    const { data: { user }, error: authErr } = await db.auth.getUser(token);
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

    // Verify commissioner
    const { data: manager, error: mErr } = await db
      .from('managers')
      .select('*')
      .eq('user_id', user.id)
      .eq('is_commissioner', true)
      .single();
    if (mErr || !manager) return json({ error: 'Commissioner only' }, 403);

    // Check draft not already in progress or complete
    const { data: draft } = await db.from('draft_state').select('*').single();
    if (!draft) return json({ error: 'Draft state not initialized' }, 400);
    if (draft.status !== 'scheduled') return json({ error: `Draft already ${draft.status}` }, 400);

    // Randomise draft slots: assign slot 1-10 randomly to 10 managers
    const { data: allManagers } = await db
      .from('managers')
      .select('id')
      .eq('league_id', manager.league_id)
      .order('created_at');

    const slots = Array.from({ length: 10 }, (_, i) => i + 1);
    shuffle(slots); // in-place Fisher-Yates

    for (let i = 0; i < allManagers.length; i++) {
      await db.from('managers').update({ draft_slot: slots[i] }).eq('id', allManagers[i].id);
    }

    // Get manager with slot 1
    const { data: firstPicker } = await db
      .from('managers')
      .select('id')
      .eq('league_id', manager.league_id)
      .eq('draft_slot', 1)
      .single();

    const deadline = new Date(Date.now() + 60_000).toISOString();

    const { error: updateErr } = await db.from('draft_state').update({
      status: 'in_progress',
      current_pick_no: 1,
      round_no: 1,
      current_manager_id: firstPicker.id,
      pick_deadline: deadline,
      timer_seconds: 60,
    }).eq('league_id', manager.league_id);

    if (updateErr) throw updateErr;

    return json({ ok: true, slot_order: slots });
  } catch (err: any) {
    return json({ error: err.message }, 500);
  }
});

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}