import { test, expect } from '@playwright/test'
import { RX, CREDS, loginWithPin } from './helpers'

// Scenario 2 — Check-in / check-out flow.
// Needs a worker login (E2E_WORKER_PIN); self-skips otherwise.
//
// This is a NON-MUTATING smoke of the flow's entry: we verify the check-in screen renders and
// that selecting a project enables the primary action. We deliberately do NOT click "ПРИШЁЛ",
// because a real check-in writes a time event to the (dev) Supabase backend and depends on GPS —
// which would make the suite flaky and mutate data. That boundary is logged below.

test.describe('Scenario 2 · Check-in flow', () => {
  test('worker reaches the check-in screen and can arm the check-in action', async ({ page }) => {
    test.skip(!CREDS.workerPin, 'SKIP: set E2E_WORKER_PIN to exercise the check-in screen.')
    const ok = await loginWithPin(page, CREDS.workerPin)
    test.skip(!ok, 'SKIP: E2E_WORKER_PIN did not authenticate.')

    await page.goto('/checkin')
    await expect(page.getByRole('heading', { name: RX.checkinTitle })).toBeVisible()

    const onShiftControls = page.getByRole('button', { name: /Завершить смену|Finish shift|Terminar turno/i })
    if (await onShiftControls.isVisible().catch(() => false)) {
      // Already on shift from prior seeded state — the check-out affordance is present. Good enough
      // as a smoke signal; we don't close the shift (mutation).
      console.log('[QA-E2E] worker already on shift — verified check-out affordance is present (not clicked).')
      await expect(onShiftControls).toBeVisible()
      return
    }

    // Off shift: the project picker + check-in button should be present.
    const projectCards = page.locator('.card.tap')
    const count = await projectCards.count()
    if (count === 0) {
      console.log('[QA-E2E] no projects visible to this worker — skipping project-selection assert (no seeded data).')
      await expect(page.getByText(RX.notOnShift)).toBeVisible()
      test.skip(true, 'SKIP: no projects available to select for check-in.')
      return
    }

    // Selecting a project is pure client state (no network / no write) and should enable check-in.
    await projectCards.first().click()
    const checkInBtn = page.getByRole('button', { name: RX.checkInBtn })
    await expect(checkInBtn).toBeEnabled()
    console.log('[QA-E2E] check-in armed (project selected, "ПРИШЁЛ" enabled). Not clicked — avoids GPS + DB write.')
  })
})
