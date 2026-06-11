// import-fixtures — upserts the fixture list and maps each fixture to a
// matchday. The mapping rule: a fixture belongs to the latest matchday
// whose lock_at <= kickoff (within ordered config phases). This is what
// makes per-matchday scoring possible (v1 had no fixture→matchday link,
// so group-stage points bled across MD1/MD2/MD3).
import { serviceClient, json, corsHeaders, getLeague, apiFootball } from '../_shared/lib.ts';

// API-Football round labels → config phase keys (group rounds map by date)
const KNOCKOUT_ROUNDS: Record<string, string> = {
  'Round of 32': 'R32',
  'Round of 16': 'R16',
  'Quarter-finals': 'QF',
  'Semi-finals': 'SF',
  'Final': 'Final',
  '3rd Place Final': 'Final',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const db = serviceClient();
    const body = await req.json().catch(() => ({}));
    const league = await getLeague(db, body.league_id);
    const ds = league.config?.data_source;
    if (!ds?.league_id || !ds?.season) return json({ error: 'config.data_source.league_id/season missing' }, 400);

    const { data: matchdays } = await db
      .from('matchdays').select('id, phase, lock_at')
      .eq('league_id', league.id).order('lock_at', { ascending: true });
    if (!matchdays?.length) return json({ error: 'Seed matchdays first' }, 400);
    const mdByPhase = Object.fromEntries(matchdays.map(m => [m.phase, m]));
    const groupMds = matchdays.filter(m => m.phase.startsWith('MD'));

    const fixtures = await apiFootball('fixtures', { league: ds.league_id, season: ds.season });
    let upserted = 0;
    for (const f of fixtures) {
      const kickoff = new Date(f.fixture?.date);
      const round: string = f.league?.round ?? '';
      let phase = KNOCKOUT_ROUNDS[round];
      if (!phase) {
        // group fixture: latest group matchday whose lock_at <= kickoff
        const md = [...groupMds].reverse().find(m => new Date(m.lock_at) <= kickoff) ?? groupMds[0];
        phase = md.phase;
      }
      const matchday = mdByPhase[phase];
      if (!matchday) continue;

      const status = f.fixture?.status?.short === 'FT' ? 'finished'
        : ['1H', '2H', 'HT', 'ET', 'P'].includes(f.fixture?.status?.short) ? 'in_progress'
        : 'scheduled';

      const { error } = await db.from('fixtures').upsert({
        league_id: league.id,
        matchday_id: matchday.id,
        ext_fixture_id: String(f.fixture.id),
        phase,
        home_team: f.teams?.home?.name ?? '',
        away_team: f.teams?.away?.name ?? '',
        kickoff_at: f.fixture.date,
        status,
      }, { onConflict: 'ext_fixture_id' });
      if (!error) upserted++;
    }
    return json({ ok: true, fixtures: upserted });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
