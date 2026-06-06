import { useEffect, useState } from 'react';
import { getMyManager, getDraftState, getStandings, getMatchdays, getTransferWindows, getMyRoster } from '../lib/supabase';
import { useNavigate } from 'react-router-dom';

export default function HomePage() {
  const navigate = useNavigate();
  const [manager, setManager] = useState<any>(null);
  const [draft, setDraft] = useState<any>(null);
  const [standings, setStandings] = useState<any[]>([]);
  const [matchdays, setMatchdays] = useState<any[]>([]);
  const [windows, setWindows] = useState<any[]>([]);
  const [roster, setRoster] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      const m = await getMyManager();
      if (!m) { navigate('/login'); return; }
      setManager(m);
      const [d, s, md, w, r] = await Promise.all([
        getDraftState(),
        getStandings(),
        getMatchdays(),
        getTransferWindows(),
        getMyRoster(m.id)
      ]);
      setDraft(d);
      setStandings(s);
      setMatchdays(md);
      setWindows(w);
      setRoster(r);
      setLoading(false);
    };
    load();
  }, [navigate]);

  if (loading) return <div className="page" style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div>;

  const myStanding = standings.find(s => s.manager_id === manager?.id);
  const topStandings = standings.slice(0, 3);
  const nextMatchday = matchdays.find(m => new Date(m.lock_at) > new Date());
  const openWindow = windows.find(w => new Date(w.opens_at) <= new Date() && new Date(w.closes_at) >= new Date());
  const activePhase = nextMatchday?.phase ?? matchdays[matchdays.length - 1]?.phase ?? 'Pre-Draft';

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: 4 }}>🏆 WC Fantasy League</h1>
          <p style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>
            Welcome back, <span style={{ color: 'var(--text)' }}>{manager?.display_name}</span>
            {manager?.is_commissioner && <span style={{ color: 'var(--accent2)', marginLeft: 6 }}>⭐ Commissioner</span>}
          </p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '0.7rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Phase</div>
          <div style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--accent)' }}>{activePhase}</div>
        </div>
      </div>

      {/* Draft status banner */}
      {draft && draft.status !== 'complete' && (
        <div className="card" style={{ marginBottom: 16, borderColor: 'var(--accent2)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 style={{ fontSize: '0.9rem', fontWeight: 600 }}>
              {draft.status === 'scheduled' ? '📋 Draft Pending' :
               draft.status === 'in_progress' ? `📣 Draft In Progress — Pick ${draft.current_pick_no}/150` :
               '⏸ Draft Paused'}
            </h2>
            <p style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>
              {draft.status === 'in_progress' ? `Round ${Math.ceil(draft.current_pick_no / 10)}, ${draft.timer_seconds}s per pick` : 'Waiting to begin'}
            </p>
          </div>
          {draft.status !== 'complete' && (
            <button className="btn-primary" onClick={() => navigate('/draft')}>
              {draft.status === 'in_progress' ? 'Go to Draft →' : 'View Draft'}
            </button>
          )}
        </div>
      )}

      {/* Quick stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 24 }}>
        <div className="card">
          <div style={{ fontSize: '0.7rem', color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 6 }}>My Points</div>
          <div style={{ fontSize: '2rem', fontWeight: 700, color: 'var(--accent)' }}>{myStanding?.total_points ?? 0}</div>
        </div>
        <div className="card">
          <div style={{ fontSize: '0.7rem', color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 6 }}>Squad Size</div>
          <div style={{ fontSize: '2rem', fontWeight: 700 }}>{roster.length}/15</div>
        </div>
        <div className="card">
          <div style={{ fontSize: '0.7rem', color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 6 }}>My Rank</div>
          <div style={{ fontSize: '2rem', fontWeight: 700 }}>
            #{standings.findIndex(s => s.manager_id === manager?.id) + 1 ?? '—'}
          </div>
        </div>
        <div className="card">
          <div style={{ fontSize: '0.7rem', color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 6 }}>
            {openWindow ? 'Window Open' : 'Next Matchday'}
          </div>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, color: openWindow ? 'var(--accent)' : 'var(--text)' }}>
            {openWindow ? openWindow.phase : nextMatchday?.label ?? '—'}
          </div>
        </div>
      </div>

      {/* Podium */}
      <div className="card" style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: '0.8rem', color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 12 }}>🏅 Leaderboard</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          {topStandings.map((s, i) => (
            <div key={s.manager_id} className="card" style={{ flex: 1, textAlign: 'center', padding: 16 }}>
              <div style={{ fontSize: '1.5rem', marginBottom: 4 }}>
                {i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉'}
              </div>
              <div style={{ fontWeight: 600, fontSize: '0.875rem' }}>{s.managers?.display_name}</div>
              <div style={{ color: 'var(--accent)', fontWeight: 700, fontSize: '1.1rem' }}>{s.total_points} pts</div>
            </div>
          ))}
        </div>
      </div>

      {/* Navigation tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        <div className="card" style={{ cursor: 'pointer' }} onClick={() => navigate('/draft')}>
          <h3 style={{ fontSize: '1rem', marginBottom: 4 }}>📣 Live Draft</h3>
          <p style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>
            {draft?.status === 'complete' ? 'Draft complete' : `${draft?.current_pick_no ?? 0}/150 picks made`}
          </p>
        </div>
        <div className="card" style={{ cursor: 'pointer' }} onClick={() => navigate('/team')}>
          <h3 style={{ fontSize: '1rem', marginBottom: 4 }}>👥 My Team</h3>
          <p style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>{roster.length} players — set your lineup</p>
        </div>
        <div className="card" style={{ cursor: 'pointer' }} onClick={() => navigate('/transfers')}>
          <h3 style={{ fontSize: '1rem', marginBottom: 4 }}>🔄 Transfers</h3>
          <p style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>
            {openWindow ? `${openWindow.free_count} free transfers` : 'Window closed'}
          </p>
        </div>
        <div className="card" style={{ cursor: 'pointer' }} onClick={() => navigate('/standings')}>
          <h3 style={{ fontSize: '1rem', marginBottom: 4 }}>📊 Standings</h3>
          <p style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>Full league table</p>
        </div>
      </div>
    </div>
  );
}