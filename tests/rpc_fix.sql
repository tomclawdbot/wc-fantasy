DROP FUNCTION IF EXISTS public.get_all_players(uuid, integer, integer);
CREATE OR REPLACE FUNCTION public.get_all_players(p_manager_id uuid DEFAULT NULL, p_offset integer DEFAULT 0, p_limit integer DEFAULT 1000)
RETURNS TABLE(
  id uuid, name text, "position" text, nation text, club text,
  status text, ranking integer, ext_player_id text,
  photo_url text, nation_flag_url text, club_logo_url text,
  owner_team_name text, owner_manager_id uuid, in_wc_squad boolean
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT
    pl.id, pl.name, pl."position", pl.nation, pl.club,
    pl.status, pl.ranking, pl.ext_player_id,
    pl.photo_url, pl.nation_flag_url, pl.club_logo_url,
    COALESCE(m.team_name, NULL::text)::text,
    r.manager_id,
    pl.in_wc_squad
  FROM players pl
  LEFT JOIN rosters r ON r.player_id = pl.id AND r.active = true AND (p_manager_id IS NULL OR r.manager_id = p_manager_id)
  LEFT JOIN managers m ON m.id = r.manager_id
  WHERE pl.status = 'active'
  ORDER BY pl.ranking ASC
  LIMIT p_limit OFFSET p_offset;
END;
$$
