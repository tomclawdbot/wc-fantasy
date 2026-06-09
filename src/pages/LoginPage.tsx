import { useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { supabase } from '../lib/supabase';

export default function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const handleMagicLink = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin + '/auth/callback' },
    });
    setLoading(false);
    if (error) {
      setError(error.message);
    } else {
      setSent(true);
    }
  };

  return (
    <div className="page" style={{ maxWidth: 400, margin: '80px auto', textAlign: 'center' }}>
      <h1 style={{ fontSize: '1.5rem', marginBottom: 8 }}>🏆 WC Fantasy League</h1>
      <p style={{ color: 'var(--muted)', marginBottom: 32, fontSize: '0.9rem' }}>
        Enter your invited email — we'll send you a magic link (no password needed)
      </p>

      {sent ? (
        <div className="card">
          <p style={{ color: 'var(--accent)', marginBottom: 8 }}>✓ Magic link sent!</p>
          <p style={{ color: 'var(--muted)', fontSize: '0.875rem' }}>
            Check your inbox at <strong>{email}</strong>
          </p>
        </div>
      ) : (
        <form onSubmit={handleMagicLink} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <input
            type="email"
            placeholder="your@email.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
          />
          {error && <p style={{ color: 'var(--danger)', fontSize: '0.875rem' }}>{error}</p>}
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? 'Sending...' : 'Send Magic Link 📧'}
          </button>
        </form>
      )}
    </div>
  );
}