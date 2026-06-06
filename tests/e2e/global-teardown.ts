import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Global teardown — stops Supabase local emulator after all tests finish.
 */
export default async function globalTeardown() {
  console.log('[GlobalTeardown] Stopping Supabase emulator...');
  try {
    await execAsync('supabase stop', { timeout: 30_000 });
  } catch (e: any) {
    // May already be stopped — non-fatal
    console.log('[GlobalTeardown] stop output:', e.stdout || e.message?.slice(0, 200));
  }
  console.log('[GlobalTeardown] Done.');
}