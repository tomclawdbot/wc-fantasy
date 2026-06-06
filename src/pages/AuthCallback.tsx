import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';

export default function AuthCallback() {
  const navigate = useNavigate();
  const [error, setError] = useState('');

  useEffect(() => {
    // Handle the magic link token from the URL
    const hash = window.location.hash;
    if (hash.includes('access_token')) {
      // Session is already set by Supabase SDK from the URL fragment
      navigate('/');
      return;
    }

    // Try to get the session from URL params
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    const refreshToken = params.get('refresh_token');

    if (token) {
      supabase.auth.setSession({
        access_token: token,
        refresh_token: refreshToken ?? '',
      }).then(({ error }) => {
        if (error) {
          setError(error.message);
        } else {
          navigate('/');
        }
      });
    } else {
      // No token in URL — try getting current session
      supabase.auth.getSession().then(({ data, error }) => {
        if (error || !data.session) {
          setError('Invalid or expired magic link');
        } else {
          navigate('/');
        }
      });
    }
  }, [navigate]);

  if (error) {
    return (
      <div style={{ textAlign: 'center', padding: 60 }}>
        <h2 style={{ color: 'var(--danger)', marginBottom: 12 }}>Authentication Failed</h2>
        <p style={{ color: 'var(--muted)' }}>{error}</p>
        <a href="/login" style={{ color: 'var(--accent)', marginTop: 16, display: 'block' }}>
          ← Back to login
        </a>
      </div>
    );
  }

  return (
    <div style={{ textAlign: 'center', padding: 60 }}>
      <div className="spinner" style={{ margin: '0 auto' }} />
      <p style={{ color: 'var(--muted)', marginTop: 16 }}>Signing you in...</p>
    </div>
  );
}