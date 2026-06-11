import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export function serviceClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
}

export interface DataSource {
  provider: string;
  league_id: number;
  season: number;
}

/** Resolve a league + its config. If no id given, uses the only league. */
export async function getLeague(db: SupabaseClient, leagueId?: string) {
  let q = db.from('leagues').select('id, name, config');
  if (leagueId) q = q.eq('id', leagueId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error('No league found');
  if (data.length > 1 && !leagueId) throw new Error('Multiple leagues — pass league_id');
  return data[0] as { id: string; name: string; config: Record<string, any> };
}

export async function apiFootball(path: string, params: Record<string, string | number>) {
  const key = Deno.env.get('API_FOOTBALL_KEY');
  if (!key) throw new Error('API_FOOTBALL_KEY env not set');
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const resp = await fetch(`https://v3.football.api-sports.io/${path}?${qs}`, {
    headers: { 'x-apisports-key': key },
  });
  if (!resp.ok) throw new Error(`API-Football ${path}: HTTP ${resp.status}`);
  const body = await resp.json();
  return (body.response ?? []) as any[];
}
