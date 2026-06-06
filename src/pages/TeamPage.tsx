import { useEffect, useState } from 'react';
import { getMyManager, getMyRoster, getMatchdays, getLineup, upsertLineup, getDraftState, type Roster, type Matchday, type Lineup, type Player } from '../lib/supabase';
import { useNavigate } from 'react-router-dom';

function getFormationCounts(xi: string[]): Record<string, number> {
  // Count positions in XI — assume we look up each player
  return { GK: 0, DEF: 0, MID: 0, FWD: 0 };
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

  const load = async () => {
    const m = await getMyManager();
    if (!m) { navigate('/login'); return; }
    setManager(m);
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
    if (xi.length !== 11) { setError('Must select exactly 11 players'); return; }
    setError('');
    setSaving(true);
    await upsertLineup(manager.id, activeMatchday, xi);
    setSaving(false);
  };

  const togglePlayer = (id: string) => {
    if (xi.includes(id)) {
      setXi(xi.filter(p => p !== id));
    } else if (xi.length < 11) {
      setXi([...xi, id]);
    }
  };

  const rosterByPos = (pos: string): Player[] =>
    roster.filter(r => r.players?.position === pos).map(r => r.players!);

  const locked = (md: Matchday) => new Date(md.lock_at) <= new Date();

  if (loading) return <div className="page" style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div>;

  const activeMd = matchdays.find(m => m.id === activeMatchday);
  const xiPlayers = xi.map(id => roster.find(r => r.player_id === id)?.players).filter(Boolean) as Player[];

  return (
    <div className="page">
      <h1 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: 20 }}>My Squad</h1>

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
                            cursor: 'pointer'
                          }}
                          onClick={() => togglePlayer(p.id)}>
                          <div style={{ fontWeight: 600, fontSize: '0.8rem' }}>{p.name}</div>
                          <div style={{ fontSize: '0.7rem', color: 'var(--muted)' }}>{p.nation}</div>
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
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 6 }}>
                {lineup.map(l => (
                  <div key={l.player_id} className="roster-player">
                    <div style={{ fontWeight: 600, fontSize: '0.8rem' }}>{l.players?.name}</div>
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