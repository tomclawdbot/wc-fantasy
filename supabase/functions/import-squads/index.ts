// import-squads — upserts tournament squads + teams from API-Football.
// Tournament identity (league_id, season) comes from leagues.config.data_source,
// not from code. Idempotent: upserts on ext ids.
import { serviceClient, json, corsHeaders, getLeague, apiFootball } from '../_shared/lib.ts';

const POSITION_MAP: Record<string, string> = {
  Goalkeeper: 'GK', Defender: 'DEF', Midfielder: 'MID', Attacker: 'FWD',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const db = serviceClient();
    const body = await req.json().catch(() => ({}));
    const league = await getLeague(db, body.league_id);
    const ds = league.config?.data_source;
    if (!ds?.league_id || !ds?.season) return json({ error: 'config.data_source.league_id/season missing' }, 400);

    // 1. Tournament teams
    const teams = await apiFootball('teams', { league: ds.league_id, season: ds.season });
    let teamCount = 0;
    for (const t of teams) {
      const { error } = await db.from('tournament_teams').upsert({
        league_id: league.id,
        team: t.team?.name,
        ext_team_id: String(t.team?.id ?? ''),
        flag_url: t.team?.logo ?? null,
      }, { onConflict: 'league_id,team' });
      if (!error) teamCount++;
    }

    // 2. Squads per team
    let playerCount = 0;
    for (const t of teams) {
      const squads = await apiFootball('players/squads', { team: t.team.id });
      for (const squad of squads) {
        for (const p of squad.players ?? []) {
          const { error } = await db.from('players').upsert({
            ext_player_id: String(p.id),
            name: p.name,
            nation: t.team.name,
            position: POSITION_MAP[p.position] ?? 'MID',
            photo_url: p.photo ?? null,
            nation_flag_url: t.team.logo ?? null,
            in_squad: true,
            status: 'active',
          }, { onConflict: 'ext_player_id' });
          if (!error) playerCount++;
        }
      }
    }

    return json({ ok: true, league: league.name, teams: teamCount, players: playerCount });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
