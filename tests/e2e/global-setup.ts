import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import path from 'path';
import dotenv from 'dotenv';

const execAsync = promisify(exec);
dotenv.config({ path: path.resolve(__dirname, '../../.env.test') });

/**
 * Global setup for Playwright E2E tests.
 * Starts Supabase local emulator and seeds test data.
 * Runs once before all tests; globalTeardown stops it after.
 */
export default async function globalSetup() {
  console.log('[GlobalSetup] Starting Supabase local emulator...');

  // Check if Supabase CLI is installed
  try {
    await execAsync('which supabase');
  } catch {
    console.error('[GlobalSetup] Supabase CLI not found. Run: brew install supabase/tap/supabase');
    throw new Error('Supabase CLI required but not installed');
  }

  // Start Supabase local
  try {
    const { stdout } = await execAsync('supabase start', {
      cwd: path.resolve(__dirname, '../..'),
      timeout: 60_000,
    });
    console.log('[GlobalSetup] Supabase started:', stdout.slice(0, 200));
  } catch (e: any) {
    // May already be running
    console.log('[GlobalSetup] Supabase start output:', e.stdout?.slice(0, 500));
  }

  // Wait for emulator to be ready
  const supabaseUrl = process.env.VITE_SUPABASE_URL || 'http://127.0.0.1:54321';
  const maxWait = 30_000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const res = await fetch(`${supabaseUrl}/health`);
      if (res.ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('[GlobalSetup] Supabase emulator ready at', supabaseUrl);

  // Run migrations
  try {
    await execAsync('supabase db push --db-url=postgresql://postgres:postgres@127.0.0.1:54322/postgres', {
      cwd: path.resolve(__dirname, '../..'),
      timeout: 60_000,
      env: { ...process.env, VITE_SUPABASE_URL: supabaseUrl },
    });
  } catch (e: any) {
    console.warn('[GlobalSetup] db push warning:', e.message?.slice(0, 300));
  }

  // Seed test data
  console.log('[GlobalSetup] Seeding test data...');
  try {
    await execAsync('npx ts-node scripts/seed.ts', {
      cwd: path.resolve(__dirname, '../..'),
      timeout: 30_000,
      env: { 
        ...process.env,
        VITE_SUPABASE_URL: supabaseUrl,
        VITE_SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7hFoLr0rSbuA-jCifTGeI8_f4MCRZR-N1HjJo',
        SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZxum7Y4yyQBFR1P2cI7PC5s3V0pYcjC3K1o',
      },
    });
  } catch (e: any) {
    console.warn('[GlobalSetup] Seed warning:', e.message?.slice(0, 300));
  }

  console.log('[GlobalSetup] Done. Emulator running and seeded.');
}