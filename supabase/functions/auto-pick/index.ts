// auto-pick — drains ALL overdue picks. Safe under pg_cron, a client
// poller, or manual invocation: every iteration re-reads draft_state and
// the auto_pick RPC no-ops on any state mismatch (lock + CAS in SQL).
import { serviceClient, json, corsHeaders } from '../_shared/lib.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const db = serviceClient();
  const results: unknown[] = [];
  const MAX_ITERATIONS = 1000; // hard cap across all leagues

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const { data: drafts, error } = await db
      .from('draft_state')
      .select('*')
      .eq('status', 'in_progress')
      .lt('pick_deadline', new Date().toISOString());
    if (error) return json({ error: error.message }, 500);
    if (!drafts || drafts.length === 0) {
      return json({ message: 'Nothing overdue', processed: results.length, picks: results });
    }

    let progressed = false;
    for (const draft of drafts) {
      const { data: result, error: rpcErr } = await db.rpc('auto_pick', {
        p_league_id: draft.league_id,
        p_manager_id: draft.current_manager_id,
        p_pick_no: draft.current_pick_no,
        p_round_no: draft.round_no,
      });
      if (rpcErr) {
        if (rpcErr.code === '55P03' || /could not obtain lock/i.test(rpcErr.message)) continue;
        return json({ error: rpcErr.message, processed: results.length }, 500);
      }
      if (result && !result.skipped) {
        results.push(result);
        progressed = true;
      }
    }
    if (!progressed) {
      return json({ message: 'No progress possible', processed: results.length, picks: results });
    }
  }
  return json({ message: 'Max iterations reached', processed: results.length, picks: results });
});
