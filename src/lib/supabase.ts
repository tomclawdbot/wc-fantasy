/// <reference types="vite/client" />
// Data layer. Same export surface as v1 so pages keep working, but:
//  * getMyManager → claim_manager_slot RPC (invite-gated, race-safe; the
//    client no longer inserts manager rows directly)
//  * upsertLineup → set_lineup RPC (atomic; formation + lock enforced server-side)
//  * makeTransfer → make_transfer RPC (window/free-count/quota enforced)
//  * getLeagueConfig → leagues.config (drives all counts in the UI)
//  * no hardcoded league IDs anywhere

import { createClient } from '@supabase/supabase-js';
import type { LeagueConfig, Position } from '../config/types';
import { FALLBACK_CONFIG } from '../config/types';

const url = import.meta.env.VITE_SUPABASE_URL as string;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
if (!url || !key) throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY');

export const supabase = createClient(url, key);
export type { Position, LeagueConfig };

// ─── Types ────────────────────────────────────────────────────

export interface Player {
  id: string;
  name: string;
  nation: string;
  club?: string;
  club_name?: string;
  position: Position;
  status: 'active' | 'withdrawn';
  ranking?: number;
  in_squad?: boolean;
  photo_url?: string;
  nation_flag_url?: string;
  club_logo_url?: string;
  owner_team_name?: string;
  owner_manager_id?: string;
}

export interface Manager {
  id: string;
  display_name: string;
  team_name?: string;
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

export interface Lineup { player_id: string; slot: number; players?: Player; }
export interface Matchday { id: string; phase: string; label: string; lock_at: string; }
export interface Standing {
  manager_id: string;
  total_points: number;
  by_phase: Record<string, number>;
  managers?: Manager;
}
export interface TransferWindow {
  id: string; phase: string; opens_at: string; closes_at: string; free_count: number;
}

// ─── League config ─────────────────────────────────────────────

let configCache: LeagueConfig | null = null;

export async function getLeagueConfig(): Promise<LeagueConfig> {
  if (configCache) return configCache;
  const { data } = await supabase.from('leagues').select('config').limit(1).single();
  configCache = data?.config && Object.keys(data.config).length > 0
    ? ({ ...FALLBACK_CONFIG, ...data.config } as LeagueConfig)
    : FALLBACK_CONFIG;
  return configCache;
}

// ─── Game RPCs (server is authoritative) ───────────────────────

export async function startDraft() {
  return supabase.rpc('start_draft');
}

export async function makePick(playerId: string) {
  const { data, error } = await supabase.rpc('make_pick', { p_player_id: playerId });
  if (error) return { error };
  if (data?.error) return { error: { message: data.error } };
  return { data, error: null };
}

export async function makeTransfer(outId: string, inId: string) {
  const { data, error } = await supabase.rpc('make_transfer', { p_out_id: outId, p_in_id: inId });
  if (error) return { error };
  if (data?.error) return { error: { message: data.error } };
  return { data, error: null };
}

/** Atomic, validated lineup save. managerId kept for call-site compat; the
 *  server resolves the caller itself, so impersonation is impossible. */
export async function upsertLineup(_managerId: string, matchdayId: string, playerIds: string[]) {
  const { data, error } = await supabase.rpc('set_lineup', {
    p_matchday_id: matchdayId,
    p_player_ids: playerIds,
  });
  if (error) return { error };
  if (data?.error) return { error: { message: data.error } };
  return { data, error: null };
}

/** Existing manager row, or claim a slot via the invite-gated RPC. */
export async function getMyManager(): Promise<Manager | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: existing } = await supabase
    .from('managers').select('*').eq('user_id', user.id).maybeSingle();
  if (existing) return existing;
  const { data } = await supabase.rpc('claim_manager_slot');
  if (!data || data.error) return null;
  return data as Manager;
}

// ─── Reads ──────────────────────────────────────────────────────

export async function getMyRoster(managerId: string) {
  const { data } = await supabase.from('rosters')
    .select('*, players(*)').eq('manager_id', managerId).eq('active', true);
  return data ?? [];
}

export async function getDraftState() {
  const { data } = await supabase.from('draft_state').select('*').maybeSingle();
  return data;
}

export async function getDraftPicks() {
  const { data } = await supabase.from('draft_picks')
    .select('*, players(*), managers(*)').order('pick_no', { ascending: true });
  return data ?? [];
}

export async function getManagers(): Promise<Manager[]> {
  const { data } = await supabase.from('managers')
    .select('*').order('draft_slot', { ascending: true });
  return data ?? [];
}

export async function getAvailablePlayers() {
  const { data: drafted } = await supabase.from('draft_picks').select('player_id');
  let query = supabase.from('players').select('*')
    .eq('status', 'active').order('ranking', { ascending: true, nullsFirst: false });
  const draftedIds = (drafted ?? []).map(p => p.player_id);
  if (draftedIds.length > 0) query = query.not('id', 'in', `(${draftedIds.join(',')})`);
  const { data } = await query;
  return data ?? [];
}

export async function getFreeAgents() {
  const [{ data: players }, { data: owned }] = await Promise.all([
    supabase.from('players').select('*').eq('status', 'active')
      .order('ranking', { ascending: true, nullsFirst: false }),
    supabase.from('rosters').select('player_id').eq('active', true),
  ]);
  const ownedIds = new Set((owned ?? []).map(r => r.player_id));
  return (players ?? []).filter(p => !ownedIds.has(p.id));
}

export async function getMyQueue(managerId: string) {
  if (!managerId) return [];
  const { data } = await supabase.from('pick_queues')
    .select('*, players(*)').eq('manager_id', managerId).order('rank', { ascending: true });
  return data ?? [];
}

export async function upsertQueue(managerId: string, playerIds: string[]) {
  await supabase.from('pick_queues').delete().eq('manager_id', managerId);
  const rows = playerIds.map((player_id, i) => ({ manager_id: managerId, player_id, rank: i + 1 }));
  if (rows.length > 0) return supabase.from('pick_queues').insert(rows);
  return { error: null };
}

export async function getLineup(managerId: string, matchdayId: string) {
  const { data } = await supabase.from('lineups')
    .select('*, players(*)')
    .eq('manager_id', managerId).eq('matchday_id', matchdayId)
    .order('slot', { ascending: true });
  return data ?? [];
}

export async function getStandings() {
  const { data } = await supabase.from('standings')
    .select('*, managers(*)').order('total_points', { ascending: false });
  return data ?? [];
}

export async function getMatchdays() {
  const { data } = await supabase.from('matchdays')
    .select('*').order('lock_at', { ascending: true });
  return data ?? [];
}

export async function getTransferWindows() {
  const { data } = await supabase.from('transfer_windows')
    .select('*').order('opens_at', { ascending: true });
  return data ?? [];
}

export async function searchPlayers(query: string, limit = 50): Promise<Player[]> {
  if (!query.trim()) return [];
  const { data, error } = await supabase.rpc('search_players', {
    search_query: query.trim(), limit_count: limit,
  });
  return error || !data ? [] : data;
}

export async function getAllPlayers(): Promise<Player[]> {
  const out: Player[] = [];
  const CHUNK = 1000;
  for (let offset = 0; offset < 20000; offset += CHUNK) {
    const { data, error } = await supabase.rpc('get_all_players', { p_offset: offset, p_limit: CHUNK });
    if (error || !data || data.length === 0) break;
    out.push(...(data as Player[]));
    if (data.length < CHUNK) break;
  }
  return out;
}

// ─── Watchlist ──────────────────────────────────────────────────

export async function getPlayerNotes(managerId: string): Promise<Record<string, { watched: boolean; note: string }>> {
  const { data } = await supabase.from('player_notes')
    .select('player_id, watched, note').eq('manager_id', managerId);
  return Object.fromEntries((data ?? []).map(r => [r.player_id, { watched: r.watched, note: r.note ?? '' }]));
}

export async function setPlayerWatched(managerId: string, playerId: string, watched: boolean, note?: string): Promise<void> {
  await supabase.from('player_notes').upsert({
    manager_id: managerId, player_id: playerId, watched, note: note ?? null,
  }, { onConflict: 'manager_id,player_id' });
}

export async function getWatchedPlayers(managerId: string): Promise<Player[]> {
  const { data } = await supabase.from('player_notes')
    .select('player_id, players(*)')
    .eq('manager_id', managerId).eq('watched', true).eq('players.status', 'active');
  return (data ?? []).map(r => r.players as unknown as Player).filter(Boolean);
}

export async function updateTeamName(managerId: string, teamName: string): Promise<void> {
  const { error } = await supabase.from('managers')
    .update({ team_name: teamName }).eq('id', managerId);
  if (error) throw error;
}

// ─── Realtime ───────────────────────────────────────────────────

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
