import { useEffect, useState } from 'react';
import { getMyManager, getMyRoster, getTransferWindows, getAvailablePlayers, type Roster, type TransferWindow, type Player } from '../lib/supabase';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';

export default function TransfersPage() {
  const navigate = useNavigate();
  const [manager, setManager] = useState<any>(null);
  const [roster, setRoster] = useState<Roster[]>([]);
  const [windows, setWindows] = useState<TransferWindow[]>([]);
  const [freeAgents, setFreeAgents] = useState<Player[]>([]);
  const [outId, setOutId] = useState('');
  const [inId, setInId] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const load = async () => {
    const m = await getMyManager();
    if (!m) { navigate('/login'); return; }
    setManager(m);
    const [r, w, fa] = await Promise.all([
      getMyRoster(m.id),
      getTransferWindows(),
      getAvailablePlayers()
    ]);
    setRoster(r);
    setWindows(w);
    setFreeAgents(fa);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const openWindow = windows.find(w =>
    new Date(w.opens_at) <= new Date() && new Date(w.closes_at) >= new Date()
  );

  const handleTransfer = async () => {
    if (!outId || !inId) { setError('Select both out and in player'); return; }
    if (outId === inId) { setError('Cannot transfer same player'); return; }
    setError('');
    setSubmitting(true);
    const { error: err } = await supabase.rpc('make_transfer', {
      p_window_id: openWindow?.id,
      p_out_id: outId,
      p_in_id: inId,
    });
    setSubmitting(false);
    if (err) { setError(err.message); }
    else { setSuccess('Transfer complete!'); setOutId(''); setInId(''); load(); }
  };

  const rosterByPos = (pos: string) =>
    roster.filter(r => r.players?.position === pos).map(r => r.players!);
  const freeByPos = (pos: string) => freeAgents.filter(p => p.position === pos);

  if (loading) return <div className="page" style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div>;

  return (
    <div className="page">
      <h1 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: 20 }}>Transfers</h1>

      {/* Open window status */}
      {openWindow ? (
        <div className="card" style={{ marginBottom: 24, borderColor: 'var(--accent)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <div>
              <h2 style={{ fontSize: '0.9rem' }}>🟢 {openWindow.phase} Transfer Window</h2>
              <p style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>
                Open until {new Date(openWindow.closes_at).toLocaleString()}
              </p>
            </div>
            <div style={{ textAlign: 'right' }}>
              <p style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>Free transfers</p>
              <p style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--accent)' }}>{openWindow.free_count}</p>
            </div>
          </div>
        </div>
      ) : (
        <div className="card" style={{ marginBottom: 24 }}>
          <p style={{ color: 'var(--muted)', textAlign: 'center', padding: 12 }}>
            {windows.length === 0 ? 'No transfer windows configured' : 'Transfer window is closed'}
          </p>
        </div>
      )}

      {/* Transfer form */}
      {openWindow && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: '0.9rem', marginBottom: 16 }}>Make a Transfer</h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <label style={{ fontSize: '0.8rem', color: 'var(--muted)', display: 'block', marginBottom: 6 }}>Send Out</label>
              <select value={outId} onChange={e => setOutId(e.target.value)}>
                <option value="">Select player...</option>
                {roster.map(r => r.players && (
                  <option key={r.player_id} value={r.player_id}>
                    {r.players.name} ({r.players.position})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ fontSize: '0.8rem', color: 'var(--muted)', display: 'block', marginBottom: 6 }}>Receive In</label>
              <select value={inId} onChange={e => setInId(e.target.value)}>
                <option value="">Select free agent...</option>
                {freeAgents.map(p => (
                  <option key={p.id} value={p.id}>{p.name} ({p.position})</option>
                ))}
              </select>
            </div>
          </div>
          {error && <p style={{ color: 'var(--danger)', fontSize: '0.875rem', marginTop: 12 }}>{error}</p>}
          {success && <p style={{ color: 'var(--accent)', fontSize: '0.875rem', marginTop: 12 }}>{success}</p>}
          <button className="btn-primary" style={{ marginTop: 16 }} onClick={handleTransfer} disabled={submitting}>
            {submitting ? 'Processing...' : 'Confirm Transfer'}
          </button>
        </div>
      )}

      {/* My roster */}
      <h2 style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: 12, textTransform: 'uppercase' }}>My Squad</h2>
      {(['GK','DEF','MID','FWD'] as const).map(pos => (
        <div key={pos} style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: '0.7rem', color: `var(--${pos.toLowerCase()})`, marginBottom: 6, textTransform: 'uppercase' }}>{pos}</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 6 }}>
            {rosterByPos(pos).map(p => (
              <div key={p.id} className="roster-player" style={{ cursor: outId && outId !== p.id ? 'pointer' : 'default', borderColor: outId === p.id ? 'var(--danger)' : undefined }} onClick={() => outId !== p.id && setOutId(p.id)}>
                <div style={{ fontWeight: 600, fontSize: '0.8rem' }}>{p.name}</div>
                <div style={{ fontSize: '0.7rem', color: 'var(--muted)' }}>{p.nation}</div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* Free agents */}
      <h2 style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: 12, marginTop: 24, textTransform: 'uppercase' }}>Free Agents</h2>
      {(['GK','DEF','MID','FWD'] as const).map(pos => (
        <div key={pos} style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: '0.7rem', color: `var(--${pos.toLowerCase()})`, marginBottom: 6, textTransform: 'uppercase' }}>{pos}</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 6 }}>
            {freeByPos(pos).map(p => (
              <div key={p.id} className="player-card" style={{ cursor: inId !== p.id ? 'pointer' : 'default', borderColor: inId === p.id ? 'var(--accent)' : undefined }} onClick={() => inId !== p.id && setInId(p.id)}>
                <div style={{ fontWeight: 600, fontSize: '0.8rem' }}>{p.name}</div>
                <div style={{ fontSize: '0.7rem', color: 'var(--muted)' }}>{p.nation}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}