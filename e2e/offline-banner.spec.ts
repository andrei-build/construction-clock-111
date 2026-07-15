import { test, expect } from '@playwright/test'
import { CREDS, loginWorkerReady } from './helpers'

// Scenario 6 — Offline banner appears when the network is cut.
// OfflineStatusBanner is only mounted inside the authenticated app shell, so this needs a login.
// We cut the network with context.setOffline(true) and expect the offline banner (role=status)
// to surface; the banner reacts to the 'offline' event and also polls navigator.onLine (~7s).

test.describe('Scenario 6 · Offline banner', () => {
  test('cutting the network shows the offline banner', async ({ page, context }) => {
    test.skip(!CREDS.workerPin, 'SKIP: set E2E_WORKER_PIN — the offline banner only renders inside the app.')
    // Onboard past the GPS-consent gate so the authed app shell (which mounts the banner) is present.
    const ok = await loginWorkerReady(page, CREDS.workerPin)
    test.skip(!ok, 'SKIP: E2E_WORKER_PIN did not authenticate / could not pass the GPS-consent gate.')

    await page.goto('/checkin')
    // IMPORTANT: goto() reloads the page, so the app re-boots and re-hydrates the profile over the
    // network (getUser + profile + consent check). Wait for the authed app shell to be fully mounted
    // BEFORE cutting the network — otherwise setOffline races the still-in-flight auth calls, they
    // fail offline, the profile drops to null and the app falls back to the login screen.
    await expect(page.locator('.app').first()).toBeVisible()
    await expect(page.getByRole('heading', { name: /Отметка|Check-?In|Marcar/i })).toBeVisible()
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
