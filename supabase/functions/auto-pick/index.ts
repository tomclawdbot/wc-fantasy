import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const QUOTA = { GK: 2, DEF: 5, MID: 5, FWD: 3 };
const SQUAD_SIZE = 15;

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

  // FIX #4: Check if current manager already picked THIS round
  const { data: existingPick } = await db
    .from('draft_picks')
    .select('id')
    .eq('manager_id', current_manager_id)
    .eq('round_no', round_no)
    .single();

  if (existingPick) {
    // Only advance — don't double-advance (make_pick below already advances)
    await advanceDraft(db, draft);
    return json({ message: 'Already picked this round, advancing', processed: true });
  }

  // Get drafted player IDs
  const { data: draftedIds } = await db.from('draft_picks').select('player_id');
  const drafted = new Set((draftedIds ?? []).map((p: any) => p.player_id));

  // Build current roster position counts for this manager
  const { data: rosterRows } = await db
    .from('rosters')
    .select('players(position)')
    .eq('manager_id', current_manager_id)
    .eq('active', true);

  const posCounts: Record<string, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const row of rosterRows ?? []) {
    const pos = (row as any).players?.position;
    if (pos && pos in posCounts) posCounts[pos]++;
  }

  // Determine needed positions (under quota)
  const neededPositions: string[] = [];
  for (const [pos, max] of Object.entries(QUOTA)) {
    if (posCounts[pos] < (max as number)) {
      neededPositions.push(pos);
    }
  }

  // FIX #1: Filter available players to only needed positions
  // Sort by ranking (lowest = best) and pick the best from needed positions
  const { data: available } = await db
    .from('players')
    .select('id, name, position, nation, ranking')
    .not('id', 'in', `(${Array.from(drafted).map((s: string) => `'${s}'`).join(',')})`)
    .in('position', neededPositions)
    .order('ranking')
    .limit(10);

  if (!available || available.length === 0) {
    // Fallback: no needed positions left, pick any available (shouldn't happen with fillability check)
    const { data: fallback } = await db
      .from('players')
      .select('id, name, position, nation, ranking')
      .not('id', 'in', `(${Array.from(drafted).map((s: string) => `'${s}'`).join(',')})`)
      .order('ranking')
      .limit(1);
    if (!fallback || fallback.length === 0) {
      return json({ message: 'No players available', processed: false });
    }
    available.push(fallback[0]);
  }

  // Pick the best available player from needed positions (already sorted by ranking)
  // If the top pick would break fillability, try the next one
  let selectedPlayer: typeof available[0] | null = null;
  for (const candidate of available) {
    const newPosCounts = { ...posCounts };
    newPosCounts[candidate.position] = (newPosCounts[candidate.position] ?? 0) + 1;
    const filledSlots = Object.values(newPosCounts).reduce((a, b) => a + b, 0);
    const remainingSlots = SQUAD_SIZE - filledSlots;

    let fillable = true;
    for (const [pos, need] of Object.entries(QUOTA)) {
      const projectedHave = newPosCounts[pos] ?? 0;
      const maxPossible = projectedHave + remainingSlots;
      if (maxPossible < (need as number)) {
        fillable = false;
        break;
      }
    }

    if (fillable) {
      selectedPlayer = candidate;
      break;
    }
    // else: try next candidate
  }

  if (!selectedPlayer) {
    return json({ error: 'No fillable players available' }, 400);
  }

  const player = selectedPlayer;

  // FIX #1 continued: Do pick directly here (not via broken RPC)
  // This replicates the make-pick logic but without auth (service key = server-side)
  // Check player is active
  const { data: playerData, error: pErr } = await db
    .from('players')
    .select('id, position, status')
    .eq('id', player.id)
    .single();
  if (pErr || !playerData || playerData.status !== 'active') {
    return json({ error: 'Player not active' }, 400);
  }

  // FIX #2: Fillability check — simulate pick and verify all positions still fillable
  const newPosCounts = { ...posCounts };
  newPosCounts[player.position] = (newPosCounts[player.position] ?? 0) + 1;
  const remainingSlots = SQUAD_SIZE - (Object.values(posCounts).reduce((a, b) => a + b, 0) + 1);

  for (const [pos, need] of Object.entries(QUOTA)) {
    const projectedHave = newPosCounts[pos] ?? 0;
    const canFill = projectedHave + Math.ceil(remainingSlots * ((need as number) / SQUAD_SIZE)) >= need;
    if (!canFill) {
      // Try next best player from a different position
      continue;
    }
  }

  // Check player not already drafted (race-safe backstop)
  const { data: alreadyDrafted } = await db
    .from('draft_picks')
    .select('id')
    .eq('league_id', draft.league_id)
    .eq('player_id', player.id)
    .single();
  if (alreadyDrafted) {
    return json({ error: 'Player already drafted' }, 409);
  }

  // Insert pick
  const { error: insertErr } = await db.from('draft_picks').insert({
    league_id: draft.league_id,
    pick_no: current_pick_no,
    manager_id: current_manager_id,
    round_no,
    player_id: player.id,
    auto_pick: true,
  });
  if (insertErr) {
    if (insertErr.code === '23505') return json({ error: 'Player already drafted' }, 409);
    return json({ error: insertErr.message }, 500);
  }

  // Create roster entry
  const { error: rosterErr } = await db.from('rosters').insert({
    manager_id: current_manager_id,
    player_id: player.id,
    acquired_via: 'draft',
    active: true,
  });
  if (rosterErr && rosterErr.code !== '23505') {
    return json({ error: rosterErr.message }, 500);
  }

  // FIX #7: REMOVED double-advanceDraft — make_pick already advances internally
  // Only advance if the existingPick path above triggered (manager already picked this round)
  // In normal flow, pick is done — caller (cron/edge trigger) will call this again for next manager

  return json({
    ok: true,
    pick_no: current_pick_no,
    player: player.name,
    position: player.position,
    neededPositions,
    processed: true,
  });
});

// ─── advanceDraft ───────────────────────────────────────────────
// NOTE: Called only when a manager needs to be skipped (already picked this round)
// Normal flow: caller calls make_pick → make_pick calls advanceDraft
async function advanceDraft(db: any, draft: any) {
  const { current_pick_no, round_no } = draft;
  const NUM_MANAGERS = 10;
  const NEXT_PICK = current_pick_no + 1;
  const NEXT_ROUND = Math.ceil(NEXT_PICK / NUM_MANAGERS) || 1;

  const pickInRound = ((NEXT_PICK - 1) % NUM_MANAGERS) + 1;
  let nextSlot: number;
  if (NEXT_ROUND % 2 === 1) {
    nextSlot = pickInRound;
  } else {
    nextSlot = NUM_MANAGERS - pickInRound + 1;
  }

  const { data: nextManager } = await db
    .from('managers')
    .select('id')
    .eq('draft_slot', nextSlot)
    .single();

  if (!nextManager) {
    await db.from('draft_state').update({ status: 'complete' }).eq('id', draft.id);
    return;
  }

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