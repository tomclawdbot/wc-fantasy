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
}

export interface Manager {
  id: string;
  display_name: string;
  draft_slot: number;
  is_commissioner: boolean;
  league_id: string;
}

export interface DraftState {
  status: 'scheduled' | 'in_progress' | 'paused' | 'complete';
  current_pick_no: number;
  round_no: number;
  pick_deadline: string | null;
  timer_seconds: number;
}

export interface DraftPick {
  pick_no: number;
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

export async function getMyManager() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase
    .from('managers')
    .select('*')
    .eq('user_id', user.id)
    .single();
  return data;
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