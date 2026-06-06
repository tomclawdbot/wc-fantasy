import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ─── import_squads ─────────────────────────────────────────────
// Fetches squads from API-Football and upserts into the players table.
// Commissioner-only. Pool locks during active draft.
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const db = createClient(supabaseUrl, serviceKey);

  const token = req.headers.get('Authorization')?.replace('Bearer ', '');
  const { data: { user } } = await db.auth.getUser(token);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const { data: manager } = await db.from('managers').select('*').eq('user_id', user.id).eq('is_commissioner', true).single();
  if (!manager) return json({ error: 'Commissioner only' }, 403);

  // Check draft not in progress
  const { data: draft } = await db.from('draft_state').select('status').eq('league_id', manager.league_id).single();
  if (draft?.status === 'in_progress') return json({ error: 'Pool locked during active draft' }, 400);

  const apiKey = Deno.env.get('API_FOOTBALL_KEY');
  if (!apiKey) return json({ error: 'API-Football key not configured' }, 500);

  // Fetch squads from API-Football
  // API-Football free tier: /fixtures?season=2026&league=1 (World Cup)
  const url = `https://v3.football.api-sports.io/players?season=2026&league=1&team=1`;
  const res = await fetch(url, {
    headers: { 'x-apisports-key': apiKey }
  });

  if (!res.ok) {
    const errText = await res.text();
    return json({ error: `API-Football error: ${errText}` }, 502);
  }

  const json_data = await res.json();
  const apiPlayers: any[] = json_data.response ?? [];

  let imported = 0;
  let errors = 0;

  for (const entry of apiPlayers) {
    try {
      const p = entry.player;
      if (!p?.id) continue;

      const { error: upsertErr } = await db.from('players').upsert({
        ext_player_id: String(p.id),
        name: `${p.firstname ?? ''} ${p.lastname ?? ''}`.trim(),
        nation: p.nationality ?? 'Unknown',
        club: entry.team?.name ?? null,
        position: normalizePosition(entry.statistics?.[0]?.games?.position ?? 'MID'),
        status: 'active',
      }, { onConflict: 'ext_player_id' });

      if (upsertErr) { errors++; console.error(upsertErr); }
      else imported++;
    } catch (e) { errors++; }
  }

  return json({ ok: true, imported, errors, total: apiPlayers.length });
});

function normalizePosition(pos: string): 'GK' | 'DEF' | 'MID' | 'FWD' {
  const map: Record<string, string> = {
    'Goalkeeper': 'GK', 'Defender': 'DEF', 'Midfielder': 'MID', 'Attacker': 'FWD', 'Forward': 'FWD',
  };
  return (map[pos] ?? 'MID') as any;
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}