import { test, expect } from '@playwright/test'
import { RX, CREDS, loginWithPin, loginWithEmail } from './helpers'

// Scenario 4 — Payroll visibility (role gate holds).
// App.tsx gates `/payroll` behind hasFinanceAccess: owner/admin (or finance_access grant) see it;
// a plain worker is redirected to "/". We assert BOTH sides when the respective credentials exist.
//
//   Owner side  → E2E_OWNER_PIN, or E2E_OFFICE_EMAIL + E2E_OFFICE_PASSWORD
//   Worker side → E2E_WORKER_PIN

const PAYROLL_HEADING = { name: /Зарплата|Payroll|Nómina/i }

test.describe('Scenario 4 · Payroll visibility', () => {
  test('payroll is VISIBLE to an owner / finance user', async ({ page }) => {
    const hasOwner = !!CREDS.ownerPin || (!!CREDS.officeEmail && !!CREDS.officePassword)
    test.skip(!hasOwner, 'SKIP: set E2E_OWNER_PIN (or E2E_OFFICE_EMAIL/PASSWORD) to verify payroll is visible to finance.')

    const ok = CREDS.ownerPin
      ? await loginWithPin(page, CREDS.ownerPin)
      : await loginWithEmail(page, CREDS.officeEmail, CREDS.officePassword)
    test.skip(!ok, 'SKIP: owner/finance credentials did not authenticate.')

    await page.goto('/payroll')
    // Not redirected away — the payroll screen renders its own heading.
    await expect(page).toHaveURL(/\/payroll$/)
    await expect(page.getByRole('heading', PAYROLL_HEADING)).toBeVisible()
    console.log('[QA-E2E] payroll VISIBLE to finance user (role gate allows).')
  })

  test('payroll is NOT visible to a plain worker (redirected home)', async ({ page }) => {
    test.skip(!CREDS.workerPin, 'SKIP: set E2E_WORKER_PIN to verify the worker payroll block.')
    const ok = await loginWithPin(page, CREDS.workerPin)
    test.skip(!ok, 'SKIP: E2E_WORKER_PIN did not authenticate.')

    await page.goto('/payroll')
    // The route gate sends non-finance users to "/". The payroll heading must be absent…
    await expect(page.getByRole('heading', PAYROLL_HEADING)).toHaveCount(0)
    // …and the URL must no longer be /payroll (redirected home).
    await expect(page).not.toHaveURL(/\/payroll$/)
    console.log('[QA-E2E] payroll NOT visible to worker (redirected home — role gate holds).')
  })
})
