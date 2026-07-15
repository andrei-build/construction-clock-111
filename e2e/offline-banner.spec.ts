import { test, expect } from '@playwright/test'
import { CREDS, loginWithPin } from './helpers'

// Scenario 6 — Offline banner appears when the network is cut.
// OfflineStatusBanner is only mounted inside the authenticated app shell, so this needs a login.
// We cut the network with context.setOffline(true) and expect the offline banner (role=status)
// to surface; the banner reacts to the 'offline' event and also polls navigator.onLine (~7s).

test.describe('Scenario 6 · Offline banner', () => {
  test('cutting the network shows the offline banner', async ({ page, context }) => {
    test.skip(!CREDS.workerPin, 'SKIP: set E2E_WORKER_PIN — the offline banner only renders inside the app.')
    const ok = await loginWithPin(page, CREDS.workerPin)
    test.skip(!ok, 'SKIP: E2E_WORKER_PIN did not authenticate.')

    await page.goto('/checkin')
    // Banner absent while online.
    await expect(page.locator('.offline-banner-offline')).toHaveCount(0)

    await context.setOffline(true)
    // Appears via the 'offline' event (fast) or the ~7s poll fallback.
    await expect(page.locator('.offline-banner-offline')).toBeVisible({ timeout: 12_000 })
    await expect(page.getByText(/Нет связи|You are offline|Sin conexión/i)).toBeVisible()
    console.log('[QA-E2E] offline banner shown after context.setOffline(true).')

    // Restore connectivity so nothing leaks into a later test.
    await context.setOffline(false)
  })
})
