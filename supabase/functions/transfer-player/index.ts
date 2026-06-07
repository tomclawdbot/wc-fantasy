import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ─── transfer-player ───────────────────────────────────────────
// Single transfer entry point — replaces make-transfer edge function.
// Writes to BOTH transfer_requests (audit/approval flow) AND transfers (ledger).
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const db = createClient(supabaseUrl, serviceKey);

  const token = req.headers.get('Authorization')?.replace('Bearer ', '');
  const { data: { user } } = await db.auth.getUser(token);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  // Args — all three optional except p_out_id and p_in_id
  const { p_out_id, p_in_id, p_window_id } = await req.json();
  if (!p_out_id || !p_in_id) {
    return json({ error: 'p_out_id and p_in_id required' }, 400);
  }

  // Get manager
  const { data: manager } = await db.from('managers').select('*').eq('user_id', user.id).single();
  if (!manager) return json({ error: 'Not a manager' }, 403);

  // Verify window is open (if window_id provided)
  if (p_window_id) {
    const { data: window } = await db.from('transfer_windows').select('*').eq('id', p_window_id).single();
    if (!window) return json({ error: 'Window not found' }, 404);
    const now = new Date();
    if (now < new Date(window.opens_at) || now > new Date(window.closes_at)) {
      return json({ error: 'Transfer window is not open' }, 400);
    }
  }

  // Verify out_player is in manager's roster
  const { data: outRoster } = await db
    .from('rosters')
    .select('id')
    .eq('manager_id', manager.id)
    .eq('player_id', p_out_id)
    .eq('active', true)
    .single();
  if (!outRoster) return json({ error: 'Player not in your roster' }, 400);

  // Verify in_player is a free agent
  const { data: inRoster } = await db
    .from('rosters')
    .select('id')
    .eq('player_id', p_in_id)
    .eq('active', true)
    .single();
  if (inRoster) return json({ error: 'Player is already owned' }, 400);

  // Verify in_player is active
  const { data: inPlayer } = await db
    .from('players')
    .select('position, status')
    .eq('id', p_in_id)
    .single();
  if (!inPlayer) return json({ error: 'Player not found' }, 404);
  if (inPlayer.status !== 'active') return json({ error: 'Player not active' }, 400);

  // Squad must not be full
  const { count: rosterSize } = await db
    .from('rosters')
    .select('id', { count: 'exact', head: true })
    .eq('manager_id', manager.id)
    .eq('active', true);
  if (rosterSize === 15) return json({ error: 'Squad is full — transfer out a player first' }, 400);

  // Do the swap
  await db.from('rosters').update({ active: false }).eq('manager_id', manager.id).eq('player_id', p_out_id);
  await db.from('rosters').insert({
    manager_id: manager.id,
    player_id: p_in_id,
    acquired_via: 'transfer',
    active: true,
  });

  // Write to BOTH tables for consistency
  // transfer_requests: audit / approval workflow
  await db.from('transfer_requests').insert({
    manager_id: manager.id,
    transfer_window_id: p_window_id ?? null,
    out_player_id: p_out_id,
    in_player_id: p_in_id,
    status: 'approved',
  });

  // transfers: permanent ledger record
  await db.from('transfers').insert({
    manager_id: manager.id,
    window_id: p_window_id ?? null,
    out_player_id: p_out_id,
    in_player_id: p_in_id,
  });

  return json({ ok: true });
});

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}