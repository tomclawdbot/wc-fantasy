import { useEffect, useState } from 'react';
import { getMyManager, getMyRoster, getMatchdays, getLineup, upsertLineup, getDraftState, updateTeamName, type Roster, type Matchday, type Lineup, type Player } from '../lib/supabase';
import { useNavigate } from 'react-router-dom';

function PlayerBadge({ player, size = 'sm' }: { player: Player; size?: 'sm' | 'lg' }) {
  const h = size === 'lg' ? 48 : 32;
  const w = size === 'lg' ? 48 : 32;
  const fotoSize = size === 'lg' ? 48 : 28;

  return (
    <div style={{ position: 'relative', width: w, height: h, flexShrink: 0 }}>
      {/* Player photo */}
      {player.photo_url ? (
        <img
          src={player.photo_url}
          alt={player.name}
          style={{ width: fotoSize, height: fotoSize, borderRadius: 4, objectFit: 'cover' }}
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
      ) : (
        <div style={{
          width: fotoSize, height: fotoSize, borderRadius: 4,
          background: 'var(--card-bg)', border: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: size === 'lg' ? '0.7rem' : '0.5rem', color: 'var(--muted)'
        }}>
          {player.name.charAt(0)}
        </div>
      )}

      {/* Club logo — bottom right */}
      {player.club_logo_url && (
        <img
          src={player.club_logo_url}
          alt={player.club_name ?? ''}
          style={{
            position: 'absolute', bottom: -2, right: -2,
            width: size === 'lg' ? 18 : 12, height: size === 'lg' ? 18 : 12,
            borderRadius: 2, border: '1px solid var(--bg)',
            background: '#fff', objectFit: 'contain'
          }}
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
      )}

      {/* Nation flag — top right */}
      {player.nation_flag_url && (
        <img
          src={player.nation_flag_url}
          alt={player.nation}
          style={{
            position: 'absolute', top: -2, right: -2,
            width: size === 'lg' ? 16 : 11, height: size === 'lg' ? 16 : 11,
            borderRadius: 2, border: '1px solid var(--bg)'
          }}
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
      )}
    </div>
  );
}

export default function TeamPage() {
  const navigate = useNavigate();
  const [manager, setManager] = useState<any>(null);
  const [roster, setRoster] = useState<Roster[]>([]);
  const [matchdays, setMatchdays] = useState<Matchday[]>([]);
  const [activeMatchday, setActiveMatchday] = useState<string>('');
  const [lineup, setLineup] = useState<Lineup[]>([]);
  const [xi, setXi] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [teamName, setTeamName] = useState('');

  const load = async () => {
    const m = await getMyManager();
    if (!m) { navigate('/login'); return; }
    setManager(m);
    setTeamName(m.team_name || m.display_name || '');
    const [r, md] = await Promise.all([getMyRoster(m.id), getMatchdays()]);
    setRoster(r);
    setMatchdays(md);
    if (md.length > 0 && !activeMatchday) setActiveMatchday(md[0].id);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (!activeMatchday || !manager) return;
    getLineup(manager.id, activeMatchday).then(data => {
      setLineup(data);
      setXi(data.map((l: Lineup) => l.player_id));
    });
  }, [activeMatchday, manager]);

  const save = async () => {
    setError('');
    setSaving(true);
    const { error: err } = await upsertLineup(manager.id, activeMatchday, xi);
    setSaving(false);
    if (err) setError(err.message ?? 'Save failed');
  };

  const togglePlayer = (id: string) => {
    if (xi.includes(id)) {
      setXi(xi.filter(p => p !== id));
    } else if (xi.length < 11) {
      setXi([...xi, id]);
    }
  };

  const saveTeamName = async () => {
    if (!teamName.trim()) return;
    await updateTeamName(manager.id, teamName.trim());
    setEditingName(false);
    setManager((m: any) => ({ ...m, team_name: teamName.trim() }));
  };

  const rosterByPos = (pos: string): Player[] =>
    roster.filter(r => r.players?.position === pos).map(r => r.players!);

  const locked = (md: Matchday) => new Date(md.lock_at) <= new Date();

  if (loading) return <div className="page" style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div>;

  const activeMd = matchdays.find(m => m.id === activeMatchday);
  const xiPlayers = xi.map(id => roster.find(r => r.player_id === id)?.players).filter(Boolean) as Player[];

  return (
    <div className="page">
      {/* Team name header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        {editingName ? (
          <>
            <input
              type="text"
              value={teamName}
              onChange={e => setTeamName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && saveTeamName()}
              autoFocus
              style={{
                flex: 1, maxWidth: 280,
                padding: '8px 12px', borderRadius: 8,
                border: '1px solid var(--accent)',
                background: 'var(--card-bg)', color: 'var(--text)',
                fontSize: '1rem', fontWeight: 700
              }}
            />
            <button className="btn-primary" onClick={saveTeamName} style={{ fontSize: '0.8rem', padding: '6px 12px' }}>Save</button>
            <button className="btn-secondary" onClick={() => { setEditingName(false); setTeamName(manager?.team_name || ''); }} style={{ fontSize: '0.8rem', padding: '6px 12px' }}>Cancel</button>
          </>
        ) : (
          <>
            <h1 style={{ fontSize: '1.25rem', fontWeight: 700 }}>{teamName || manager?.display_name}</h1>
            <button
              onClick={() => setEditingName(true)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.75rem', color: 'var(--muted)', textDecoration: 'underline', padding: 0 }}
            >
              Edit name
            </button>
          </>
        )}
      </div>

      {/* Matchday selector */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {matchdays.map(md => (
          <button key={md.id} className={activeMatchday === md.id ? 'btn-primary' : 'btn-secondary'}
            onClick={() => setActiveMatchday(md.id)}>
            {md.label} {locked(md) ? '🔒' : ''}
          </button>
        ))}
      </div>

      {activeMd && (
        <>
          <p style={{ color: 'var(--muted)', fontSize: '0.8rem', marginBottom: 16 }}>
            {locked(activeMd) ? '🔒 Lineup locked' : `Lock: ${new Date(activeMd.lock_at).toLocaleString()}`}
          </p>

          {/* Formation slots */}
          {!locked(activeMd) && (
            <>
              <div className="card" style={{ marginBottom: 20 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                  <h2 style={{ fontSize: '0.9rem' }}>Starting XI — {xi.length}/11</h2>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {(['GK','DEF','MID','FWD'] as const).map(p => (
                      <span key={p} className={`badge badge-${p.toLowerCase()}`} style={{ fontSize: '0.7rem' }}>
                        {p}: {xiPlayers.filter(pl => pl.position === p).length}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="formation-grid">
                  {Array.from({ length: 11 }, (_, i) => {
                    const player = xiPlayers[i];
                    return (
                      <div key={i} className={`formation-slot ${player ? 'filled' : ''}`}
                        onClick={() => !locked(activeMd) && player && togglePlayer(player.id)}>
                        {player ? (
                          <>
                            <PlayerBadge player={player} size="sm" />
                            <span style={{ fontSize: '0.6rem', color: 'var(--accent)', fontWeight: 700 }}>{player.position}</span>
                            <span style={{ fontSize: '0.65rem', fontWeight: 600, marginTop: 2 }}>{player.name.split(' ').pop()}</span>
                          </>
                        ) : (
                          <span style={{ color: 'var(--muted)', fontSize: '0.6rem' }}>?</span>
                        )}
                      </div>
                    );
                  })}
                </div>

                {error && <p style={{ color: 'var(--danger)', fontSize: '0.875rem', marginBottom: 12 }}>{error}</p>}
                <button className="btn-primary" onClick={save} disabled={saving || xi.length !== 11}>
                  {saving ? 'Saving...' : 'Save Lineup'}
                </button>
              </div>

              {/* Roster to pick from */}
              <h2 style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: 12, textTransform: 'uppercase' }}>Pick from Squad</h2>
              {(['GK','DEF','MID','FWD'] as const).map(pos => (
                <div key={pos} style={{ marginBottom: 20 }}>
                  <h3 style={{ fontSize: '0.75rem', color: `var(--${pos.toLowerCase()})`, marginBottom: 8, textTransform: 'uppercase' }}>{pos}</h3>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {rosterByPos(pos).map(p => {
                      const inXi = xi.includes(p.id);
                      return (
                        <div key={p.id} className={`roster-player ${inXi ? 'selected' : ''}`}
                          style={{
                            borderColor: inXi ? 'var(--accent)' : undefined,
                            background: inXi ? 'rgba(74,222,128,0.08)' : undefined,
                            cursor: 'pointer',
                            display: 'flex', alignItems: 'center', gap: 8,
                            padding: '6px 10px',
                          }}
                          onClick={() => togglePlayer(p.id)}>
                          <PlayerBadge player={p} size="sm" />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 600, fontSize: '0.8rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</div>
                            <div style={{ fontSize: '0.65rem', color: 'var(--muted)' }}>{p.club_name || p.nation}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </>
          )}

          {locked(activeMd) && (
            <div className="card">
              <h2 style={{ fontSize: '0.9rem', marginBottom: 12 }}>Your XI for {activeMd.label}</h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 6 }}>
                {lineup.map(l => (
                  <div key={l.player_id} className="roster-player" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <PlayerBadge player={l.players} size="sm" />
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '0.8rem' }}>{l.players?.name}</div>
                      <div style={{ fontSize: '0.65rem', color: 'var(--muted)' }}>{l.players?.club_name || l.players?.nation}</div>
                    </div>
                    <span className={`badge badge-${l.players?.position?.toLowerCase()}`}>{l.players?.position}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}