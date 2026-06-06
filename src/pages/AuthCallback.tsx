import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';

export default function AuthCallback() {
  const navigate = useNavigate();

  useEffect(() => {
    // Supabase magic links put token in the URL fragment: #access_token=xxx
    const hash = window.location.hash;
    const params = new URLSearchParams(window.location.search);

    // Try fragment first (magic link format)
    const fragmentParams = new URLSearchParams(hash.replace('#', '?'));
    const accessToken = fragmentParams.get('access_token') ?? params.get('access_token');
    const refreshToken = fragmentParams.get('refresh_token') ?? params.get('refresh_token');
    const token = params.get('token'); // also check ?token=

    const sessionToken = accessToken ?? token;

    if (sessionToken) {
      supabase.auth.setSession({
        access_token: sessionToken,
        refresh_token: refreshToken ?? '',
      }).then(({ error }) => {
        if (error) {
          navigate('/login');
        } else {
          navigate('/');
        }
      });
    } else {
      // No token in URL — check if there's an existing session
      supabase.auth.getSession().then(({ data }) => {
        if (data.session) {
          navigate('/');
        } else {
          navigate('/login');
        }
      });
    }
  }, [navigate]);

  return (
    <div style={{ textAlign: 'center', padding: 60 }}>
      <div className="spinner" style={{ margin: '0 auto' }} />
      <p style={{ color: 'var(--muted)', marginTop: 16 }}>Signing you in...</p>
    </div>
  );
}