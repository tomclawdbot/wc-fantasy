import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';

export default function AuthCallback() {
  const navigate = useNavigate();

  useEffect(() => {
    // Try getSessionFromURL (Supabase v2 handles magic link tokens here)
    const handleCallback = async () => {
      const { data, error } = await supabase.auth.getSessionFromURL();
      if (!error && data.session) {
        navigate('/');
        return;
      }

      // Fallback: manually extract token from URL params (Supabase magic links use ?token=)
      const params = new URLSearchParams(window.location.search);
      const token = params.get('token');
      const refreshToken = params.get('refresh_token');
      if (token) {
        const { error: setErr } = await supabase.auth.setSession({
          access_token: token,
          refresh_token: refreshToken ?? '',
        });
        if (!setErr) {
          navigate('/');
          return;
        }
      }

      // Nothing worked → redirect to login
      navigate('/login');
    };

    handleCallback();
  }, [navigate]);

  return (
    <div style={{ textAlign: 'center', padding: 60 }}>
      <div className="spinner" style={{ margin: '0 auto' }} />
      <p style={{ color: 'var(--muted)', marginTop: 16 }}>Signing you in...</p>
    </div>
  );
}