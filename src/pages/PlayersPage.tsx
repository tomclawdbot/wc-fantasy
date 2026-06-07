import { useEffect, useState } from 'react';
import { getMyManager, getAllPlayers, getPlayerNotes, setPlayerWatched, getWatchedPlayers, type Player } from '../lib/supabase';
import { useNavigate } from 'react-router-dom';

function PlayerCard({ player, watched, onWatch, showing }: {
  player: Player;
  watched: boolean;
  onWatch: (w: boolean) => void;
  showing: 'all' | 'watchlist';
}) {
  const isOwned = !!player.owner_team_name;

  return (
    <div className="roster-player" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, opacity: isOwned ? 0.75 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        {/* Player photo + badges */}
        <div style={{ position: 'relative', flexShrink: 0 }}>
          {player.photo_url ? (
            <img src={player.photo_url} alt={player.name}
              style={{ width: 56, height: 56, borderRadius: 6, objectFit: 'cover', border: '1px solid var(--border)' }}
              onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
          ) : (
            <div style={{
              width: 56, height: 56, borderRadius: 6, background: 'var(--card-bg)',
              border: '1px solid var(--border)', display: 'flex', alignItems: 'center',
              justifyContent: 'center', fontSize: '1.2rem', color: 'var(--muted)'
            }}>
              {player.name.charAt(0)}
            </div>
          )}
          {/* Nation flag top-right */}
          {player.nation_flag_url && (
            <img src={player.nation_flag_url} alt={player.nation}
              style={{ position: 'absolute', top: -4, right: -4, width: 18, height: 18, borderRadius: 3, border: '1px solid var(--bg)' }}
              onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
          )}
          {/* Club logo bottom-right */}
          {player.club_logo_url && (
            <img src={player.club_logo_url} alt={player.club_name ?? ''}
              style={{ position: 'absolute', bottom: -4, right: -4, width: 20, height: 20, borderRadius: 3, border: '1px solid var(--bg)', background: '#fff', objectFit: 'contain' }}
              onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
          )}
        </div>

        {/* Info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: '0.875rem', marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {player.name}
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginBottom: 4 }}>
            {player.club_name || player.nation}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className={`badge badge-${player.position.toLowerCase()}`}>{player.position}</span>
            {player.ranking && (
              <span style={{ fontSize: '0.65rem', color: 'var(--muted)', background: 'var(--bg)', padding: '2px 6px', borderRadius: 4 }}>
                #{player.ranking}
              </span>
            )}
          </div>
          {/* Ownership badge */}
          {player.owner_team_name && (
            <div style={{ marginTop: 4, fontSize: '0.65rem', color: 'var(--accent)', fontWeight: 600 }}>
              ★ {player.owner_team_name}
            </div>
          )}
        </div>

        {/* Watch button */}
        <button
          onClick={(e) => { e.stopPropagation(); onWatch(!watched); }}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: '1.3rem', padding: 4, flexShrink: 0,
            filter: watched ? 'none' : 'grayscale(1) opacity(0.4)',
          }}
          title={watched ? 'Remove from watchlist' : 'Add to watchlist'}
        >
          {watched ? '★' : '☆'}
        </button>
      </div>
    </div>
  );
}

type FilterPos = 'ALL' | 'GK' | 'DEF' | 'MID' | 'FWD';
type SortKey = 'ranking' | 'name' | 'nation';

export default function PlayersPage() {
  const navigate = useNavigate();
  const [manager, setManager] = useState<any>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [watched, setWatched] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState('');
  const [filterPos, setFilterPos] = useState<FilterPos>('ALL');
  const [sortBy, setSortBy] = useState<SortKey>('ranking');
  const [tab, setTab] = useState<'all' | 'watchlist'>('all');
  const [loading, setLoading] = useState(true);

  const load = async () => {
    const m = await getMyManager();
    if (!m) { navigate('/login'); return; }
    setManager(m);

    const [allPlayers, notes] = await Promise.all([
      getAllPlayers(),
      getPlayerNotes(m.id),
    ]);
    setPlayers(allPlayers);
    setWatched(Object.fromEntries(Object.entries(notes).map(([k, v]) => [k, v.watched])));
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const toggleWatch = async (playerId: string, value: boolean) => {
    setWatched(prev => ({ ...prev, [playerId]: value }));
    await setPlayerWatched(manager.id, playerId, value);
  };

  // Filter + sort
  const searchNorm = search.toLowerCase().trim();
  // Deduplication: for players with same normalized surname + nation,
  // keep only the best-ranked (lowest number) and hide the rest from the main grid.
  // Normalize: strip accents from full name, extract last word as surname.
  const stripAccents = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const lastNameKey = (p: Player) => stripAccents(p.name.split(' ').slice(-1)[0] ?? '');
  const bestRank: Record<string, number> = {};
  for (const p of players) { const k = lastNameKey(p) + '|' + p.nation; if (!bestRank[k] || (p.ranking ?? 999) < bestRank[k]) bestRank[k] = p.ranking ?? 999; }
  const isDuplicate = (p: Player) => {
    const k = lastNameKey(p) + '|' + p.nation;
    return (p.ranking ?? 999) > bestRank[k];
  };

  const filtered = players.filter(p => {
    if (tab === 'watchlist' && !watched[p.id]) return false;
    if (filterPos !== 'ALL' && p.position !== filterPos) return false;
    // Hide duplicate entries (same surname+position+nation but worse ranking)
    if (tab === 'all' && isDuplicate(p)) return false;
    if (searchNorm && !p.name.toLowerCase().includes(searchNorm) &&
        !p.nation.toLowerCase().includes(searchNorm) &&
        !(p.club_name ?? '').toLowerCase().includes(searchNorm)) return false;
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === 'ranking') return (a.ranking ?? 999) - (b.ranking ?? 999);
    if (sortBy === 'name') return a.name.localeCompare(b.name);
    if (sortBy === 'nation') return a.nation.localeCompare(b.nation);
    return 0;
  });

  const watchedCount = Object.values(watched).filter(Boolean).length;
  const positions: FilterPos[] = ['ALL', 'GK', 'DEF', 'MID', 'FWD'];

  if (loading) return <div className="page" style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div>;

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700 }}>Player Research</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className={tab === 'all' ? 'btn-primary' : 'btn-secondary'}
            onClick={() => setTab('all')}
          >
            All Players ({players.length})
          </button>
          <button
            className={tab === 'watchlist' ? 'btn-primary' : 'btn-secondary'}
            onClick={() => setTab('watchlist')}
          >
            ★ Watchlist ({watchedCount})
          </button>
        </div>
      </div>

      {/* Search + filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          type="text"
          placeholder="Search name, club, nation..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            flex: 1, minWidth: 180,
            padding: '8px 12px', borderRadius: 8,
            border: '1px solid var(--border)', background: 'var(--card-bg)',
            color: 'var(--text)', fontSize: '0.875rem'
          }}
        />

        <div style={{ display: 'flex', gap: 4 }}>
          {positions.map(pos => (
            <button
              key={pos}
              onClick={() => setFilterPos(pos)}
              className={filterPos === pos ? 'btn-primary' : 'btn-secondary'}
              style={{ fontSize: '0.75rem', padding: '6px 10px' }}
            >
              {pos}
            </button>
          ))}
        </div>

        <select
          value={sortBy}
          onChange={e => setSortBy(e.target.value as SortKey)}
          style={{
            padding: '8px 10px', borderRadius: 8,
            border: '1px solid var(--border)', background: 'var(--card-bg)',
            color: 'var(--text)', fontSize: '0.8rem'
          }}
        >
          <option value="ranking">Sort: Ranking</option>
          <option value="name">Sort: Name A-Z</option>
          <option value="nation">Sort: Nation</option>
        </select>
      </div>

      {/* Results count */}
      <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginBottom: 12 }}>
        {tab === 'watchlist' ? `★ ${sorted.length} watched players` : `Showing ${sorted.length} of ${players.length} players`}
      </div>

      {/* Player grid */}
      {sorted.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--muted)' }}>
          {tab === 'watchlist' ? 'No players in your watchlist yet. Tap ☆ on any player to add them.' : 'No players match your search.'}
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: 10,
        }}>
          {sorted.map(p => (
            <PlayerCard
              key={p.id}
              player={p}
              watched={!!watched[p.id]}
              onWatch={(w) => toggleWatch(p.id, w)}
              showing={tab}
            />
          ))}
        </div>
      )}
    </div>
  );
}