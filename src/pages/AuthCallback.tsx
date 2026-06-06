import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';

export default function AuthCallback() {
  const navigate = useNavigate();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    const refreshToken = params.get('refresh_token');

    if (!token) {
      navigate('/login');
      return;
    }

    supabase.auth.setSession({
      access_token: token,
      refresh_token: refreshToken ?? '',
    }).then(({ error }) => {
      if (error) {
        navigate('/login');
        return;
      }
      // Give the auth state a moment to propagate, then go home
      setTimeout(() => navigate('/'), 200);
    });
  }, [navigate]);

  return (
    <div style={{ textAlign: 'center', padding: 60 }}>
      <div className="spinner" style={{ margin: '0 auto' }} />
      <p style={{ color: 'var(--muted)', marginTop: 16 }}>Signing you in...</p>
    </div>
  );
}