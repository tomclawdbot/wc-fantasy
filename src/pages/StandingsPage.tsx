import { useEffect, useState } from 'react';
import { getStandings, getMyManager, subscribeToStandings, type Standing, type Manager } from '../lib/supabase';
import { useNavigate } from 'react-router-dom';

export default function StandingsPage() {
  const navigate = useNavigate();
  const [standings, setStandings] = useState<Standing[]>([]);
  const [manager, setManager] = useState<Manager | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    const m = await getMyManager();
    if (!m) { navigate('/login'); return; }
    setManager(m);
    const data = await getStandings();
    setStandings(data);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  useEffect(() => {
    const unsub = subscribeToStandings(load);
    return unsub;
  }, []);

  if (loading) return <div className="page" style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div>;

  return (
    <div className="page">
      <h1 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: 20 }}>Standings</h1>

      <div className="card">
        <table className="standings-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Manager</th>
              <th style={{ textAlign: 'right' }}>Total Pts</th>
              {['MD1','MD2','MD3','R32','R16','QF','SF','Final'].map(phase => (
                <th key={phase} style={{ textAlign: 'center' }}>{phase}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {standings.map((s, i) => (
              <tr key={s.manager_id} style={manager?.id === s.manager_id ? { background: 'rgba(74,222,128,0.05)' } : undefined}>
                <td style={{ color: i === 0 ? 'var(--accent)' : 'var(--muted)', fontWeight: i === 0 ? 700 : 400 }}>{i + 1}</td>
                <td>
                  {s.managers?.display_name ?? 'Unknown'}
                  {manager?.id === s.manager_id && <span style={{ marginLeft: 6, color: 'var(--accent)', fontSize: '0.7rem' }}>← you</span>}
                  {s.managers?.is_commissioner && <span style={{ marginLeft: 6, color: 'var(--accent2)', fontSize: '0.7rem' }}>⭐</span>}
                </td>
                <td style={{ textAlign: 'right', fontWeight: 700 }}>{s.total_points}</td>
                {['MD1','MD2','MD3','R32','R16','QF','SF','Final'].map(phase => (
                  <td key={phase} style={{ textAlign: 'center', color: 'var(--muted)' }}>
                    {s.by_phase?.[phase] ?? '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}