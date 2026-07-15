import { test, expect } from '@playwright/test'
import { RX, keypad, CREDS, loginWithPin } from './helpers'

// Scenario 1 — PIN login. The deterministic half (app boots to the login gate, tab switch,
// bad credentials rejected, a wrong PIN does not grant access) runs with no seeded data and is
// always green. The "valid PIN reaches the app" half needs a real PIN and self-skips otherwise.

test.describe('Scenario 1 · PIN login', () => {
  test('app boots to the PIN login screen', async ({ page }) => {
    await page.goto('/')
    // Brand heading (language-independent) + the PIN prompt + a full numeric keypad.
    await expect(page.getByRole('heading', { name: /Construction Clock/i })).toBeVisible()
    await expect(page.getByText(RX.enterPin)).toBeVisible()
    for (const digit of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']) {
      await expect(page.getByRole('button', { name: digit, exact: true })).toBeVisible()
    }
  })

  test('office tab reveals email + password, then worker tab restores the keypad', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: RX.officeTab }).click()
    await expect(page.locator('input[type="email"]')).toBeVisible()
    await expect(page.locator('input[type="password"]')).toBeVisible()
    await expect(page.getByRole('button', { name: RX.signIn })).toBeVisible()

    await page.getByRole('button', { name: RX.workerTab }).click()
    await expect(keypad(page)).toBeVisible()
  })

  test('bad office credentials are rejected and stay on the login screen', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: RX.officeTab }).click()
    await page.locator('input[type="email"]').fill(`qa-e2e+${'noone'}@example.invalid`)
    await page.locator('input[type="password"]').fill('definitely-not-the-password')
    await page.getByRole('button', { name: RX.signIn }).click()

    // The invalid-credentials message surfaces and we never reach the app.
    await expect(page.getByText(RX.invalidCreds)).toBeVisible()
    await expect(page.getByRole('button', { name: RX.officeTab })).toBeVisible()
  })

  test('a wrong PIN does not grant access', async ({ page }) => {
    await page.goto('/')
    const worker = page.getByRole('button', { name: RX.workerTab })
    if (await worker.isVisible().catch(() => false)) await worker.click()

    // Typing digits fills the PIN dots (client-side state, no navigation for a short/bad PIN).
    for (const d of ['9', '9', '9']) {
      await page.getByRole('button', { name: d, exact: true }).click()
    }
    await expect(page.locator('.pin-dot.filled')).toHaveCount(3)

    // Complete a full but wrong 4-digit attempt; the app must remain on the login gate.
    await page.getByRole('button', { name: '9', exact: true }).click()
    await page.waitForTimeout(1500) // allow the auto-attempt to resolve
    await expect(page.getByText(RX.enterPin)).toBeVisible()
    await expect(keypad(page)).toBeVisible()
  })

  test('valid PIN reaches the app', async ({ page }) => {
    test.skip(!CREDS.workerPin, 'SKIP: set E2E_WORKER_PIN to exercise a real successful PIN login.')
    const ok = await loginWithPin(page, CREDS.workerPin)
    expect(ok, 'E2E_WORKER_PIN did not authenticate — check the value').toBeTruthy()
    // We left the login gate: the PIN prompt is gone.
    await expect(page.getByText(RX.enterPin)).toBeHidden()
  })
})
