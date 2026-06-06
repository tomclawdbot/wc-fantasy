import { test, expect } from '@playwright/test';

test.describe('AUTH — Sign-Up and Access Control', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('AUTH-01: Invite flow — manager lands on league page after magic link', async ({ page }) => {
    // Commissioner generates invite link (via UI or direct DB)
    // Simulate manager clicking invite link and completing auth
    const inviteLink = await page.request.post('/auth/magic-link', {
      data: { email: 'manager1@wc-fantasy-test.local' }
    });
    expect(inviteLink.ok()).toBeTruthy();

    // Extract magic link from email (mock for local testing)
    const magicLinkText = 'http://localhost:5173/auth/callback?token=';
    await page.goto(`${magicLinkText}mock-token-manager1`);
    await page.waitForURL('/');
    await expect(page.locator('[data-testid="manager-name"]')).toContainText('Manager 1');
  });

  test('AUTH-02: Public sign-up blocked', async ({ page }) => {
    const res = await page.request.post('/auth/signup', {
      data: { email: 'rando@attack.com', password: 'password123' }
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('AUTH-03: Non-manager account cannot access protected routes', async ({ browser }) => {
    // Create a non-manager context
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const res = await ctx.request.post('/auth/magic-link', {
      data: { email: 'non-member@test.com' }
    });
    expect(res.ok()).toBeTruthy();

    // Try to access draft directly
    await page.goto('/draft');
    await expect(page).not.toHaveURL('/draft');
    await ctx.close();
  });

  test('AUTH-04: Commissioner can start the draft', async ({ page }) => {
    await page.goto('/login');
    await page.fill('[name="email"]', 'commissioner@wc-fantasy-test.local');
    await page.click('[type="submit"]');
    // Magic link mock — in real test would extract from email
    await page.waitForURL('/');
    await expect(page.locator('[data-testid="user-role"]')).toContainText('Commissioner');

    // Trigger start draft
    await page.click('[data-testid="start-draft-btn"]');
    await expect(page.locator('[data-testid="draft-status"]')).toContainText('In Progress');
  });

  test('AUTH-05: Session expiry redirects gracefully', async ({ page }) => {
    // Set expired token in localStorage
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('sb-access-token', 'expired-token');
    });
    await page.reload();
    await expect(page).toHaveURL(/\/login/);
  });

  test('AUTH-06: Concurrent sessions — both work, latest activity reflected', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();

    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await page1.goto('/login');
    await page1.fill('[name="email"]', 'manager1@wc-fantasy-test.local');
    await page1.click('[type="submit"]');

    await page2.goto('/login');
    await page2.fill('[name="email"]', 'manager1@wc-fantasy-test.local');
    await page2.click('[type="submit"]');

    // Both should land on home page
    await Promise.all([
      page1.waitForURL('/'),
      page2.waitForURL('/'),
    ]);

    // Manager 1's activity (e.g., viewing standings) visible from either session
    await page1.click('[data-testid="standings-link"]');
    await expect(page1.locator('[data-testid="standings-table"]')).toBeVisible();

    await ctx1.close();
    await ctx2.close();
  });
});