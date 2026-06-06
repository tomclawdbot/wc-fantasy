import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';

export default function AuthCallback() {
  const navigate = useNavigate();

  useEffect(() => {
    // Supabase magic links use ?token= in the URL
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    const refreshToken = params.get('refresh_token');

    if (token) {
      supabase.auth.setSession({
        access_token: token,
        refresh_token: refreshToken ?? '',
      }).then(({ error }) => {
        if (!error) {
          navigate('/');
        } else {
          navigate('/login');
        }
      });
    } else {
      // No token — try getting existing session
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