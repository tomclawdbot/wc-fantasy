import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, useEffect } from 'react';
import { supabase } from './lib/supabase';
import type { Session } from '@supabase/supabase-js';

// Pages
import HomePage from './pages/HomePage';
import DraftPage from './pages/DraftPage';
import TeamPage from './pages/TeamPage';
import TransfersPage from './pages/TransfersPage';
import StandingsPage from './pages/StandingsPage';
import LoginPage from './pages/LoginPage';

const queryClient = new QueryClient();

function NavBar() {
  const location = useLocation();
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => listener.subscription.unsubscribe();
  }, []);

  if (!session) return null;

  const navLinks = [
    { to: '/', label: 'League' },
    { to: '/draft', label: 'Draft' },
    { to: '/team', label: 'Team' },
    { to: '/transfers', label: 'Transfers' },
    { to: '/standings', label: 'Standings' },
  ];

  return (
    <nav className="nav">
      {navLinks.map(l => (
        <Link key={l.to} to={l.to} className={location.pathname === l.to ? 'active' : ''}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <NavBar />
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/draft" element={<DraftPage />} />
          <Route path="/team" element={<TeamPage />} />
          <Route path="/transfers" element={<TransfersPage />} />
          <Route path="/standings" element={<StandingsPage />} />
          <Route path="/login" element={<LoginPage />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}