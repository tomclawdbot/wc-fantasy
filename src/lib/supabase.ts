/// <reference types="vite/client" />

import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!url || !key) {
  throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY');
}

export const supabase = createClient(url, key);

// ─── Types ────────────────────────────────────────────────────

export type Position = 'GK' | 'DEF' | 'MID' | 'FWD';

export interface Player {
  id: string;
  name: string;
  nation: string;
  club?: string;
  position: Position;
  status: 'active' | 'withdrawn';
  ranking?: number;
  photo_url?: string;
  nation_flag_url?: string;
  club_name?: string;
  club_logo_url?: string;
  owner_team_name?: string;  // populated when player is drafted
  owner_manager_id?: string; // for the viewer's own drafted players
}

export interface Manager {
  id: string;
  display_name: string;
  draft_slot: number;
  is_commissioner: boolean;
  league_id: string;
  team_name?: string;
}

export interface DraftState {
  status: 'scheduled' | 'in_progress' | 'paused' | 'complete';
  current_pick_no: number;
  round_no: number;
  pick_deadline: string | null;
  timer_seconds: number;
  league_id: string;
  current_manager_id: string;
}

export interface DraftPick {
  pick_no: number;
  round_no: number;
  manager_id: string;
  player_id: string;
  auto_pick: boolean;
  players?: Player;
  managers?: Manager;
}

export interface Roster {
  id: string;
  player_id: string;
  acquired_via: 'draft' | 'transfer' | 'free_agent';
  active: boolean;
  players?: Player;
}

export interface Lineup {
  player_id: string;
  slot: number;
  players?: Player;
}

export interface Matchday {
  id: string;
  phase: string;
  label: string;
  lock_at: string;
}

export interface Standing {
  manager_id: string;
  total_points: number;
  by_phase: Record<string, number>;
  managers?: Manager;
}

export interface TransferWindow {
  id: string;
  phase: string;
  opens_at: string;
  closes_at: string;
  free_count: number;
}

// ─── RPC Helpers ───────────────────────────────────────────────

export async function startDraft() {
  return supabase.rpc('start_draft');
}

export async function makePick(playerId: string) {
  return supabase.rpc('make_pick', { p_player_id: playerId });
}

export async function searchPlayers(query: string, limit = 50): Promise<Player[]> {
  if (!query.trim()) return [];
  const { data, error } = await supabase.rpc('search_players', {
    search_query: query.trim(),
    limit_count: limit,
  });
  if (error || !data) return [];
  return data.map((p: any) => ({ ...p, similarity: p.similarity }));
}

export async function getMyManager() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  // First check: does this user already have a manager record?
  const { data: existing } = await supabase
    .from('managers')
    .select('*')
    .eq('user_id', user.id)
    .single();
  if (existing) return existing;

  // New user — find the first empty slot (user_id IS NULL) and claim it by INSERT
  // (UPDATE won't work due to RLS — no UPDATE policy on managers table)
  const { data: emptySlots } = await supabase
    .from('managers')
    .select('id, league_id, draft_slot, team_name')
    .is('user_id', null)
    .order('draft_slot', { ascending: true })
    .limit(1);

  if (emptySlots && emptySlots.length > 0) {
    const slot = emptySlots[0];
    const leagueId = slot.league_id ?? '11111111-1111-1111-1111-111111111111';
    // Try to INSERT a new record for this user in the empty slot's league
    const { data: newManager, error } = await supabase
      .from('managers')
      .insert({
        league_id: leagueId,
        user_id: user.id,
        draft_slot: slot.draft_slot,
        team_name: slot.team_name ?? 'My Team',
        is_commissioner: false,
      })
      .select()
      .single();

    if (newManager) return newManager;
    // If INSERT failed (e.g. slot was taken concurrently), try UPDATE as fallback
    if (error) {
      const { data: updated } = await supabase
        .from('managers')
        .update({ user_id: user.id })
        .eq('id', slot.id)
        .select()
        .single();
      if (updated) return updated;
    }
  }

  // No empty slots — league is full
  return null;
}

export async function getMyRoster(managerId: string) {
  const { data } = await supabase
    .from('rosters')
    .select('*, players(*)')
    .eq('manager_id', managerId)
    .eq('active', true);
  return data ?? [];
}

export async function getDraftState() {
  const { data } = await supabase
    .from('draft_state')
    .select('*')
    .single();
  return data;
}

export async function getDraftPicks() {
  const { data } = await supabase
    .from('draft_picks')
    .select('*, players(*), managers(*)')
    .order('pick_no', { ascending: true });
  return data ?? [];
}

export async function getAvailablePlayers() {
  const { data: drafted } = await supabase
    .from('draft_picks')
    .select('player_id');

  let query = supabase
    .from('players')
    .select('*')
    .eq('status', 'active')
    .order('ranking', { ascending: true });

  if (drafted && drafted.length > 0) {
    const draftedIds = drafted.map(p => p.player_id);
    if (draftedIds.length > 0) {
      query = query.not('id', 'in', `(${draftedIds.join(',')})`);
    }
  }

  const { data } = await query;
  return data ?? [];
}

export async function getFreeAgents() {
  // Players not in any active roster — available for transfer
  const { data } = await supabase
    .from('players')
    .select('*')
    .eq('status', 'active')
    .order('ranking', { ascending: true });
  if (!data) return [];
  // Filter client-side against owned players
  const { data: owned } = await supabase
    .from('rosters')
    .select('player_id')
    .eq('active', true);
  const ownedIds = new Set((owned ?? []).map(r => r.player_id));
  return data.filter(p => !ownedIds.has(p.id));
}

export async function getMyQueue(managerId: string) {
  const { data } = await supabase
    .from('pick_queues')
    .select('*, players(*)')
    .eq('manager_id', managerId)
    .order('rank', { ascending: true });
  return data ?? [];
}

export async function upsertQueue(managerId: string, playerIds: string[]) {
  // Replace entire queue
  await supabase.from('pick_queues').delete().eq('manager_id', managerId);
  const rows = playerIds.map((player_id, i) => ({ manager_id: managerId, player_id, rank: i + 1 }));
  if (rows.length > 0) {
    return supabase.from('pick_queues').insert(rows);
  }
  return { error: null };
}

export async function getLineup(managerId: string, matchdayId: string) {
  const { data } = await supabase
    .from('lineups')
    .select('*, players(*)')
    .eq('manager_id', managerId)
    .eq('matchday_id', matchdayId)
    .order('slot', { ascending: true });
  return data ?? [];
}

export async function upsertLineup(managerId: string, matchdayId: string, playerIds: string[]) {
  // Delete existing, insert new
  await supabase.from('lineups').delete()
    .eq('manager_id', managerId).eq('matchday_id', matchdayId);
  const rows = playerIds.map((player_id, i) => ({ manager_id: managerId, matchday_id: matchdayId, player_id, slot: i + 1 }));
  return supabase.from('lineups').insert(rows);
}

export async function getStandings() {
  const { data } = await supabase
    .from('standings')
    .select('*, managers(*)')
    .order('total_points', { ascending: false });
  return data ?? [];
}

export async function getMatchdays() {
  const { data } = await supabase
    .from('matchdays')
    .select('*')
    .order('lock_at', { ascending: true });
  return data ?? [];
}

export async function getTransferWindows() {
  const { data } = await supabase
    .from('transfer_windows')
    .select('*')
    .order('opens_at', { ascending: true });
  return data ?? [];
}

// ─── Realtime Subscriptions ───────────────────────────────────

export function subscribeToDraft(onUpdate: () => void) {
  const channel = supabase.channel('draft')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'draft_state' }, onUpdate)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'draft_picks' }, onUpdate);
  channel.subscribe();
  return () => supabase.removeChannel(channel);
}

export function subscribeToStandings(onUpdate: () => void) {
  const channel = supabase.channel('standings')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'match_scores' }, onUpdate)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'standings' }, onUpdate);
  channel.subscribe();
  return () => supabase.removeChannel(channel);
}
export async function getPlayerNotes(managerId: string): Promise<Record<string, { watched: boolean; note: string }>> {
  const { data } = await supabase
    .from('player_notes')
    .select('player_id, watched, note')
    .eq('manager_id', managerId);
  return Object.fromEntries((data ?? []).map(r => [r.player_id, { watched: r.watched, note: r.note ?? '' }]));
}

export async function setPlayerWatched(managerId: string, playerId: string, watched: boolean, note?: string): Promise<void> {
  await supabase.from('player_notes').upsert({
    manager_id: managerId,
    player_id: playerId,
    watched,
    note: note ?? null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'manager_id,player_id' });
}

export async function getAllPlayers(): Promise<Player[]> {
  // Get my manager ID for ownership highlighting
  const { data: { user } } = await supabase.auth.getUser();
  let myManagerId: string | null = null;
  if (user) {
    const { data: m } = await supabase.from('managers').select('id').eq('user_id', user.id).single();
    myManagerId = m?.id ?? null;
  }

  // Fetch players WITHOUT join to avoid PostgREST 1000-row cap on joined queries
  const { data: players, error } = await supabase
    .from('players')
    .select('*')
    .eq('status', 'active')
    .range(0, 9999);  // Use range() to explicitly bypass PostgREST 1000-row default cap

  if (error) return [];
  if (!players || players.length === 0) return [];

  // Fetch all active rosters + their managers separately (avoids join row-limit cap)
  const { data: rosters } = await supabase
    .from('rosters')
    .select('player_id, manager_id, active, managers(id, team_name)')
    .eq('active', true)
    .limit(10000);

  // Build a map of player_id -> {team_name, manager_id} from active rosters
  const rosterMap: Record<string, { team_name: string; manager_id: string }> = {};
  for (const r of (rosters ?? [])) {
    if (r.active) {
      rosterMap[r.player_id] = {
        team_name: (r.managers as any)?.team_name ?? null,
        manager_id: r.manager_id,
      };
    }
  }

  return (players as any[]).map((p: any) => {
    const owner = rosterMap[p.id];
    return {
      ...p,
      owner_team_name: owner?.team_name ?? undefined,
      owner_manager_id: owner?.manager_id ?? undefined,
    };
  });
}

export async function getWatchedPlayers(managerId: string): Promise<Player[]> {
  const { data } = await supabase
    .from('player_notes')
    .select('player_id, players(*)')
    .eq('manager_id', managerId)
    .eq('watched', true)
    .eq('players.status', 'active');
  return (data ?? []).map(r => r.players as unknown as Player).filter(Boolean);
}

export async function updateTeamName(managerId: string, teamName: string): Promise<void> {
  const { error } = await supabase
    .from('managers')
    .update({ team_name: teamName, updated_at: new Date().toISOString() })
    .eq('id', managerId);
  if (error) throw error;
}
