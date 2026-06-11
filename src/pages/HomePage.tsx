import { useEffect, useState } from 'react';
import { getMyManager, getDraftState, getStandings, getMatchdays, getTransferWindows, getMyRoster, getManagers, getLeagueConfig } from '../lib/supabase';
import { useNavigate } from 'react-router-dom';

export default function HomePage() {
  const navigate = useNavigate();
  const [manager, setManager] = useState<any>(null);
  const [draft, setDraft] = useState<any>(null);
  const [standings, setStandings] = useState<any[]>([]);
  const [matchdays, setMatchdays] = useState<any[]>([]);
  const [windows, setWindows] = useState<any[]>([]);
  const [roster, setRoster] = useState<any[]>([]);
  const [numManagers, setNumManagers] = useState(1);
  const [totalPicks, setTotalPicks] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      // getMyManager claims a slot via the invite-gated claim_manager_slot RPC
      const m = await getMyManager();
      if (!m) { navigate('/login'); return; }

      setManager(m);
      const [d, s, md, w, r, mgrs, cfg] = await Promise.all([
        getDraftState(),
        getStandings(),
        getMatchdays(),
        getTransferWindows(),
        getMyRoster(m.id),
        getManagers(),
        getLeagueConfig()
      ]);
      setDraft(d);
      setStandings(s);
      setMatchdays(md);
      setWindows(w);
      setRoster(r);
      const n = mgrs.filter((x: any) => x.draft_slot != null).length || 1;
      setNumManagers(n);
      setTotalPicks(n * cfg.squad.size);
      setLoading(false);
    };
    load().catch(err => {
      console.error('HomePage load error:', err);
      setLoading(false);
    });
  }, [navigate]);

  if (loading) return <div className="page" style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div>;

  const myStanding = standings.find(s => s.manager_id === manager?.id);
  const topStandings = standings.slice(0, 3);
  const nextMatchday = matchdays.find(m => new Date(m.lock_at) > new Date());
  const openWindow = windows.find(w => new Date(w.opens_at) <= new Date() && new Date(w.closes_at) >= new Date());
  const activePhase = nextMatchday?.phase ?? matchdays[matchdays.length - 1]?.phase ?? 'Pre-Draft';

  // No league data yet — show welcome/setup screen
  if (!draft) {
    return (
      <div className="page">
        <div style={{ textAlign: 'center', padding: '40px 20px' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: 8 }}>🏆 WC Fantasy League</h1>
          <p style={{ color: 'var(--muted)', marginBottom: 32 }}>Welcome, {manager?.display_name}! Your league is being set up.</p>
          <div className="card" style={{ maxWidth: 400, margin: '0 auto', textAlign: 'left' }}>
            <h2 style={{ fontSize: '1rem', marginBottom: 12 }}>📋 Commissioner Setup</h2>
            <p style={{ color: 'var(--muted)', fontSize: '0.875rem', marginBottom: 16 }}>As commissioner, you'll need to:</p>
            <ol style={{ color: 'var(--muted)', fontSize: '0.875rem', paddingLeft: 20, lineHeight: 2 }}>
              <li>Add the 10 managers to the league</li>
              <li>Import World Cup players from API-Football</li>
              <li>Start the snake draft</li>
              <li>Set up matchdays and transfer windows</li>
            </ol>
            <p style={{ color: 'var(--muted)', fontSize: '0.8rem', marginTop: 16 }}>
              Use the Supabase dashboard (Table Editor → managers) to add yourself and other managers. Set your <code>is_commissioner=true</code>, then return here to start the draft.
            </p>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginTop: 24 }}>
            <div className="card" style={{ cursor: 'pointer' }} onClick={() => navigate('/draft')}>
              <h3 style={{ fontSize: '1rem', marginBottom: 4 }}>📣 Draft</h3>
              <p style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>View draft room (pending start)</p>
            </div>
            <div className="card" style={{ cursor: 'pointer' }} onClick={() => navigate('/team')}>
              <h3 style={{ fontSize: '1rem', marginBottom: 4 }}>👥 My Team</h3>
              <p style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>0 players — after draft</p>
            </div>
            <div className="card" style={{ cursor: 'pointer' }} onClick={() => navigate('/standings')}>
              <h3 style={{ fontSize: '1rem', marginBottom: 4 }}>📊 Standings</h3>
              <p style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>No data yet</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

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
               draft.status === 'in_progress' ? `📣 Draft In Progress — Pick ${draft.current_pick_no}/${totalPicks}` :
               '⏸ Draft Paused'}
            </h2>
            <p style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>
              {draft.status === 'in_progress' ? `Round ${Math.ceil(draft.current_pick_no / Math.max(numManagers, 1))}, ${draft.timer_seconds}s per pick` : 'Waiting to begin'}
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
            #{standings.findIndex(s => s.manager_id === manager?.id) + 1 || '—'}
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
              <div style={{ fontWeight: 600, fontSize: '0.875rem' }}>{s.managers?.team_name || s.managers?.display_name}</div>
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
            {draft?.status === 'complete' ? 'Draft complete' : `${draft?.current_pick_no ?? 0}/${totalPicks} picks made`}
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