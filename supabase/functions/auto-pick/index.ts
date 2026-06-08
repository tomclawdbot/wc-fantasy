import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Drains ALL overdue picks in one invocation by repeatedly calling the
// auto_pick RPC (single source of truth for pick selection + snake advance).
// Safe to call from pg_cron, a client poller, or manually — it no-ops when
// no deadline has passed.
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const db = createClient(supabaseUrl, serviceKey);

  const results: any[] = [];
  const MAX_ITERATIONS = 150; // hard cap = full draft, prevents runaway loop

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const { data: draft, error: draftErr } = await db
      .from('draft_state')
      .select('*')
      .eq('status', 'in_progress')
      .maybeSingle();

    if (draftErr) return json({ error: draftErr.message }, 500);
    if (!draft) {
      return json({ message: 'No active draft', processed: results.length, picks: results });
    }

    if (draft.pick_deadline && new Date(draft.pick_deadline) > new Date()) {
      return json({ message: 'Deadline not passed', processed: results.length, picks: results });
    }

    const { data: result, error: rpcErr } = await db.rpc('auto_pick', {
      p_league_id: draft.league_id,
      p_manager_id: draft.current_manager_id,
      p_pick_no: draft.current_pick_no,
      p_round_no: draft.round_no,
    });

    if (rpcErr) {
      if (rpcErr.code === '55P03' || /could not obtain lock/i.test(rpcErr.message)) {
        return json({ message: 'Locked by another pick, will retry', processed: results.length, picks: results });
      }
      return json({ error: rpcErr.message, processed: results.length, picks: results }, 500);
    }

    if (result?.skipped) {
      return json({ message: 'Nothing to process: ' + (result.reason ?? 'skipped'), processed: results.length, picks: results });
    }

    results.push(result);

    if (result?.draft_complete) {
      return json({ message: 'Draft complete', processed: results.length, picks: results });
    }
  }

  return json({ message: 'Max iterations reached', processed: results.length, picks: results });
});

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
