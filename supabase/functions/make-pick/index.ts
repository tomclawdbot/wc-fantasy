import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ─── make_pick ──────────────────────────────────────────────────
// Called by: authenticated manager
// Args: player_id (uuid)
// Returns: { ok: true } or { error: "..." }
// Enforcement:
//   - Only current picker can pick
//   - Pick within deadline
//   - UNIQUE(league_id, player_id) as final backstop
//   - Quota check (server-side)
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const db = createClient(supabaseUrl, serviceKey);

    // Auth
    const token = req.headers.get('Authorization')?.replace('Bearer ', '');
    const { data: { user }, error: authErr } = await db.auth.getUser(token);
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401);

    const { player_id } = await req.json();
    if (!player_id) return json({ error: 'player_id required' }, 400);

    // Get manager
    const { data: manager, error: mErr } = await db
      .from('managers')
      .select('*')
      .eq('user_id', user.id)
      .single();
    if (mErr || !manager) return json({ error: 'Not a manager in this league' }, 403);

    // Get draft state
    const { data: draft, error: dErr } = await db
      .from('draft_state')
      .select('*')
      .eq('league_id', manager.league_id)
      .single();
    if (dErr || !draft) return json({ error: 'No draft found' }, 400);
    if (draft.status !== 'in_progress') return json({ error: `Draft is ${draft.status}` }, 400);

    // Determine current picker's slot
    const currentSlot = getCurrentSlot(draft.current_pick_no);
    if (draft.current_manager_id !== manager.id && manager.draft_slot !== currentSlot) {
      // Also allow if manager's slot matches current picker
      const { data: curManager } = await db.from('managers').select('draft_slot').eq('id', draft.current_manager_id).single();
      if (manager.draft_slot !== currentSlot) {
        return json({ error: 'Not your turn to pick' }, 403);
      }
    }

    // Check deadline not passed
    if (draft.pick_deadline && new Date(draft.pick_deadline) < new Date()) {
      // Auto-pick should have fired; reject late picks
      return json({ error: 'Pick deadline passed' }, 400);
    }

    // Verify player is available
    const { data: player, error: pErr } = await db
      .from('players')
      .select('id, position, status')
      .eq('id', player_id)
      .single();
    if (pErr || !player) return json({ error: 'Player not found' }, 404);
    if (player.status !== 'active') return json({ error: 'Player not active' }, 400);

    // Check draft not already made by this manager for this pick (idempotency)
    const { data: existingPick } = await db
      .from('draft_picks')
      .select('id')
      .eq('league_id', manager.league_id)
      .eq('pick_no', draft.current_pick_no)
      .eq('manager_id', manager.id)
      .single();
    if (existingPick) return json({ error: 'Already picked this round' }, 400);

    // Check player not already drafted (UNIQUE constraint backup check)
    const { data: alreadyDrafted } = await db
      .from('draft_picks')
      .select('id')
      .eq('league_id', manager.league_id)
      .eq('player_id', player_id)
      .single();
    if (alreadyDrafted) return json({ error: 'Player already drafted' }, 409);

    // Server-side quota check (max + fillability)
    const quotaError = await checkQuota(db, manager.id, player.position, manager.league_id);
    if (quotaError) return json({ error: quotaError }, 400);

    // Insert pick (UNIQUE constraint is the race-safe backstop)
    const { error: insertErr } = await db.from('draft_picks').insert({
      league_id: manager.league_id,
      pick_no: draft.current_pick_no,
      manager_id: manager.id,
      player_id,
      auto_pick: false,
    });
    if (insertErr) {
      // Check if it's a duplicate error (UNIQUE constraint)
      if (insertErr.code === '23505') return json({ error: 'Player already drafted (race-safe block)' }, 409);
      throw insertErr;
    }

    // Create roster entry
    const { error: rosterErr } = await db.from('rosters').insert({
      manager_id: manager.id,
      player_id,
      acquired_via: 'draft',
      active: true,
    });
    if (rosterErr && rosterErr.code !== '23505') throw rosterErr; // 23505 = already exists (OK)

    // Advance draft state
    await advanceDraft(db, manager.league_id);

    return json({ ok: true });
  } catch (err: any) {
    return json({ error: err.message }, 500);
  }
});

// ─── advanceDraft ───────────────────────────────────────────────
async function advanceDraft(db: ReturnType<typeof createClient>, leagueId: string) {
  const { data: draft } = await db
    .from('draft_state')
    .select('*')
    .eq('league_id', leagueId)
    .single();

  const nextPickNo = draft.current_pick_no + 1;
  const nextRound = Math.ceil(nextPickNo / 10);

  if (nextPickNo > 150) {
    // Draft complete
    await db.from('draft_state').update({
      status: 'complete',
      current_pick_no: 150,
      pick_deadline: null,
    }).eq('league_id', leagueId);
    return;
  }

  const nextSlot = getCurrentSlot(nextPickNo);
  const { data: nextManager } = await db
    .from('managers')
    .select('id')
    .eq('league_id', leagueId)
    .eq('draft_slot', nextSlot)
    .single();

  const deadline = new Date(Date.now() + draft.timer_seconds * 1000).toISOString();

  await db.from('draft_state').update({
    current_pick_no: nextPickNo,
    round_no: nextRound,
    current_manager_id: nextManager?.id ?? null,
    pick_deadline: deadline,
  }).eq('league_id', leagueId);
}

function getCurrentSlot(pickNo: number): number {
  const round = Math.ceil(pickNo / 10);
  const pos = pickNo - (round - 1) * 10;
  return round % 2 === 1 ? pos : 11 - pos;
}

async function checkQuota(
  db: ReturnType<typeof createClient>,
  managerId: string,
  position: string,
  leagueId: string
): Promise<string | null> {
  const QUOTA = { GK: 2, DEF: 5, MID: 5, FWD: 3 };
  const SQUAD_SIZE = 15;

  // Count current picks for this manager
  const { data: currentPicks } = await db
    .from('draft_picks')
    .select('player_id, players(position)')
    .eq('manager_id', managerId);

  const posCounts: Record<string, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const pick of currentPicks ?? []) {
    const pos = (pick as any).players?.position;
    if (pos && pos in posCounts) posCounts[pos]++;
  }

  const quota = QUOTA[position as keyof typeof QUOTA] ?? 99;

  // FIX #2: Per-position max check
  if ((posCounts[position] ?? 0) >= quota) {
    return `${position} quota exceeded (${posCounts[position]}/${quota})`;
  }

  // FIX #2: Fillability check — simulate this pick and verify all quotas remain achievable
  const newPosCounts = { ...posCounts };
  newPosCounts[position] = (newPosCounts[position] ?? 0) + 1;
  const remainingSlots = SQUAD_SIZE - Object.values(newPosCounts).reduce((a, b) => a + b, 0);

  for (const [pos, need] of Object.entries(QUOTA)) {
    const projectedHave = newPosCounts[pos] ?? 0;
    // Can we still fill this quota with remaining slots?
    const maxPossible = projectedHave + remainingSlots;
    const fillable = maxPossible >= (need as number);
    if (!fillable) {
      return `Pick would make ${pos} quota unfillable (need ${need}, max possible ${maxPossible})`;
    }
  }

  return null;
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}