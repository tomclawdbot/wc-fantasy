import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getMyManager, getDraftState, getDraftPicks, getAvailablePlayers,
  getMyQueue, upsertQueue, makePick, subscribeToDraft, supabase, type DraftState, type DraftPick, type Player
} from '../lib/supabase';

function getSnakeOrder(rounds = 15): number[] {
  const picks: number[] = [];
  for (let r = 1; r <= rounds; r++) {
    for (let s = 1; s <= 10; s++) picks.push(r % 2 === 1 ? s : 11 - s);
  }
  return picks;
}

function getManagerForPick(pickNo: number): number {
  const round = Math.ceil(pickNo / 10);
  const pos = pickNo - (round - 1) * 10;
  return round % 2 === 1 ? pos : 11 - pos;
}

function Timer({ deadline }: { deadline: string | null }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (!deadline) { setSecs(0); return; }
    const tick = () => setSecs(Math.max(0, Math.floor((new Date(deadline).getTime() - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [deadline]);
  if (!deadline) return null;
  const urgent = secs <= 10;
  const warning = secs <= 30;
  return (
    <div className={`countdown ${urgent ? 'urgent' : warning ? 'warning' : ''}`}>
      {String(Math.floor(secs / 60)).padStart(2, '0')}:{String(secs % 60).padStart(2, '0')}
    </div>
  );
}

function QuotaBar({ current, max, label }: { current: number; max: number; label: string }) {
  const colors: Record<string, string> = { GK: 'var(--gk)', DEF: 'var(--def)', MID: 'var(--mid)', FWD: 'var(--fwd)' };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: '0.75rem', color: 'var(--muted)', minWidth: 30 }}>{label}</span>
      <div style={{ flex: 1, height: 6, background: 'var(--surface2)', borderRadius: 3 }}>
        <div style={{ width: `${(current / max) * 100}%`, height: '100%', background: colors[label] ?? 'var(--accent)', borderRadius: 3, transition: 'width 0.3s' }} />
      </div>
      <span style={{ fontSize: '0.75rem', color: 'var(--muted)', minWidth: 30 }}>{current}/{max}</span>
    </div>
  );
}

export default function DraftPage() {
  const navigate = useNavigate();
  const [manager, setManager] = useState<any>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [picks, setPicks] = useState<DraftPick[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [queue, setQueue] = useState<any[]>([]);
  const [filter, setFilter] = useState<string>('ALL');
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pickError, setPickError] = useState('');
  const [showQueue, setShowQueue] = useState(false);
  const [queueEdit, setQueueEdit] = useState<string[]>([]);

  const SNAKE = getSnakeOrder();

  const mySlot = manager?.draft_slot ?? 0;
  const isMyTurn = draft?.status === 'in_progress' && getManagerForPick(draft.current_pick_no) === mySlot;
  const currentPickerSlot = draft?.current_pick_no ? getManagerForPick(draft.current_pick_no) : 1;

  // Count my roster by position
  const myPicks = picks.filter(p => p.managers?.draft_slot === mySlot);
  const countPos = (pos: string) => myPicks.filter(p => p.players?.position === pos).length;

  const fetchAll = useCallback(async () => {
    const [m, d, p, pl, q] = await Promise.all([
      getMyManager(), getDraftState(), getDraftPicks(), getAvailablePlayers(), getMyQueue(manager?.id ?? '')
    ]);
    if (!m) { navigate('/login'); return; }
    setManager(m);
    setDraft(d);
    setPicks(p);
    setPlayers(pl);
    if (q.length > 0 && queueEdit.length === 0) setQueueEdit(q.map((e: any) => e.player_id));
    setLoading(false);
  }, [navigate, manager?.id]);

  useEffect(() => {
    fetchAll();
    const unsub = subscribeToDraft(fetchAll);
    return () => { unsub(); };
  }, [fetchAll]);

  const handlePick = async () => {
    if (!selected) return;
    setPickError('');
    const { error } = await makePick(selected);
    if (error) {
      setPickError(error.message ?? 'Pick failed');
    } else {
      setSelected(null);
      fetchAll();
    }
  };

  const handleSaveQueue = async () => {
    await upsertQueue(manager.id, queueEdit);
    setShowQueue(false);
    fetchAll();
  };

  const filtered = filter === 'ALL' ? players : players.filter(p => p.position === filter);

  if (loading) return <div className="page" style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div>;
  if (!manager) return null;

  const quota = { GK: 2, DEF: 5, MID: 5, FWD: 3 };

  return (
    <div className="page">
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 700 }}>Live Snake Draft</h1>
          <p style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>
            {draft?.status === 'complete' ? '✓ Draft Complete' :
             draft?.status === 'in_progress' ? `Pick ${draft.current_pick_no} of 150 — Round ${Math.ceil((draft.current_pick_no) / 10)}` :
             'Waiting to start'}
          </p>
        </div>
        {isMyTurn && <Timer deadline={draft?.pick_deadline ?? null} />}
        {manager?.is_commissioner && draft?.status === 'scheduled' && (
          <button className="btn-primary" onClick={async () => {
            const { data, error } = await supabase.rpc('start_draft');
            if (error) alert('Failed: ' + error.message);
            else fetchAll();
          }}>Start Draft</button>
        )}
      </div>

      {/* Quota bars */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
        {(['GK','DEF','MID','FWD'] as const).map(p => (
          <QuotaBar key={p} label={p} current={countPos(p)} max={quota[p]} />
        ))}
      </div>

      {/* Draft board */}
      <div className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Draft Board</h2>
        <div className="draft-board">
          {Array.from({ length: 10 }, (_, i) => i + 1).map(slot => {
            const slotPicks = picks.filter(p => p.managers?.draft_slot === slot);
            return (
              <div key={slot} style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                <div className={`draft-board-header ${slot === currentPickerSlot && draft?.status === 'in_progress' ? 'active' : ''}`}>
                  {slot === mySlot ? `You (${slot})` : `Slot ${slot}`}
                </div>
                {Array.from({ length: 15 }, (_, r) => {
                  const pickNo = r * 10 + slot;
                  const pick = picks.find(p => p.pick_no === pickNo);
                  const isActive = slot === currentPickerSlot && draft?.status === 'in_progress';
                  return (
                    <div key={r} className={`draft-board-cell ${isActive ? 'your-turn' : ''} ${pick ? 'picked' : ''}`}>
                      {pick ? '✓' : pickNo <= (draft?.current_pick_no ?? 0) ? '—' : ''}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* Pick log */}
      {picks.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: 8, textTransform: 'uppercase' }}>Recent Picks</h2>
          <div className="pick-log">
            {picks.slice(-10).reverse().map(pick => (
              <div key={pick.pick_no} className={`pick-entry ${pick.auto_pick ? 'auto' : ''}`}>
                <span className="pick-no">#{pick.pick_no}</span>
                <span className="pick-manager">{pick.managers?.display_name ?? `Slot ${pick.managers?.draft_slot}`}</span>
                <span className="pick-player">
                  {pick.players?.name ?? pick.player_id}
                  {pick.players?.position && <span className={`badge badge-${pick.players.position.toLowerCase()}`} style={{ marginLeft: 6 }}>{pick.players.position}</span>}
                </span>
                {pick.auto_pick && <span style={{ color: 'var(--muted)', fontSize: '0.7rem' }}>auto</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pick action */}
      {draft?.status !== 'complete' && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: 12, textTransform: 'uppercase' }}>
            {isMyTurn ? '🎯 Your Turn — select a player' : `Slot ${currentPickerSlot} is picking...`}
          </h2>

          {isMyTurn && !showQueue && (
            <>
              <div className="pool-filters">
                {['ALL','GK','DEF','MID','FWD'].map(f => (
                  <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>{f}</button>
                ))}
              </div>
              <div className="player-list">
                {filtered.map(p => (
                  <div key={p.id} className={`player-card ${selected === p.id ? 'selected' : ''}`} onClick={() => setSelected(p.id)}>
                    <div className="player-name">{p.name}</div>
                    <div className="player-meta">{p.club}</div>
                    <div className="player-nation">{p.nation}</div>
                    <span className={`badge badge-${p.position.toLowerCase()}`} style={{ alignSelf: 'flex-start', marginTop: 4 }}>{p.position}</span>
                  </div>
                ))}
              </div>
              {pickError && <p className="toast error" style={{ position: 'static', marginTop: 12 }}>{pickError}</p>}
              <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                <button className="btn-primary" onClick={handlePick} disabled={!selected}>Confirm Pick</button>
                <button className="btn-secondary" onClick={() => setShowQueue(true)}>Edit Queue</button>
              </div>
            </>
          )}

          {!isMyTurn && (
            <p style={{ color: 'var(--muted)', textAlign: 'center', padding: '20px 0' }}>
              Waiting for Slot {currentPickerSlot} to pick...
            </p>
          )}

          {showQueue && (
            <div className="queue-panel">
              <h3 style={{ marginBottom: 12, fontSize: '0.9rem' }}>Your Pick Queue (auto-pick order)</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                {queueEdit.map((pid, i) => {
                  const p = players.find(p => p.id === pid) ?? queue.find((q: any) => q.player_id === pid)?.players;
                  return p ? (
                    <div key={pid} className="queue-item">
                      <span style={{ color: 'var(--muted)', minWidth: 20 }}>{i + 1}</span>
                      <span style={{ flex: 1 }}>{p.name}</span>
                      <span className={`badge badge-${p.position.toLowerCase()}`}>{p.position}</span>
                      <button className="btn-danger" style={{ padding: '2px 8px', fontSize: '0.75rem' }}
                        onClick={() => setQueueEdit(q => q.filter(id => id !== pid))}>✕</button>
                    </div>
                  ) : null;
                })}
              </div>
              <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: 12 }}>
                Add from available players above, then save.
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn-primary" onClick={handleSaveQueue}>Save Queue</button>
                <button className="btn-secondary" onClick={() => setShowQueue(false)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {draft?.status === 'complete' && (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <h2 style={{ color: 'var(--accent)', marginBottom: 8 }}>✓ Draft Complete!</h2>
          <p style={{ color: 'var(--muted)', marginBottom: 20 }}>All 150 picks made. Head to Team to set your lineup.</p>
          <button className="btn-primary" onClick={() => navigate('/team')}>Go to My Team →</button>
        </div>
      )}
    </div>
  );
}