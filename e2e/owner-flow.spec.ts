import { test, expect } from '@playwright/test'
import { CREDS, loginWithPin } from './helpers'

// Scenarios 7–9 — owner-flow smoke. These deliberately avoid the worker-hydration path (no PIN
// worker + GPS-consent gate): an owner is a manager role, so login lands straight in the app shell
// with no consent gate. All three self-skip cleanly when E2E_OWNER_PIN is absent.
//
//   7  Командный центр (/dispatch) renders its core panels   — owner control console
//   8  Overview (/overview) manager dashboard renders         — manager-gated screen
//   9  Archive (/archive) renders                             — manager-gated archive/trash path
//
// All three are READ-ONLY. They intentionally do NOT create board tasks: a created task cannot be
// removed again (task soft-delete is blocked by RLS — see qa-diag-findings.md, bug #1), so a
// create/cleanup lifecycle would leave undeletable residue on every run. Once that bug is fixed a
// create → advance → delete lifecycle spec should be added here.

// Language-agnostic matchers (ru | en | es).
const RXO = {
  commandCenter: /Командный центр|Command center|Centro de mando/i,
  board: /Доска задач|Task board|Tablero de tareas/i,
  teamMessage: /Сообщения команде|Message the crew|Mensaje al equipo/i,
  overview: /Обзор|Overview|Resumen/i,
  archive: /Архив|Archive|Archivo/i,
}

test.describe('Scenario 7 · Command Center renders', () => {
  test('owner opens the Командный центр and its core panels are present', async ({ page }) => {
    test.skip(!CREDS.ownerPin, 'SKIP: set E2E_OWNER_PIN to exercise the owner Command Center.')
    const ok = await loginWithPin(page, CREDS.ownerPin)
    test.skip(!ok, 'SKIP: E2E_OWNER_PIN did not authenticate.')

    await page.goto('/dispatch')
    // Not redirected (owner is a manager) + the three anchor panels render.
    await expect(page).toHaveURL(/\/dispatch$/)
    await expect(page.getByRole('heading', { name: RXO.commandCenter })).toBeVisible()
    await expect(page.getByRole('heading', { name: RXO.teamMessage })).toBeVisible()
    await expect(page.getByRole('heading', { name: RXO.board })).toBeVisible()
    // The board's manager-write affordance (assign-task form) is present for an owner.
    await expect(page.locator('#cc-assign-task input').first()).toBeVisible()
    console.log('[QA-E2E] Command Center rendered (message composer + task board + assign form).')
  })
})

test.describe('Scenario 8 · Overview dashboard renders', () => {
  test('owner opens the manager Overview dashboard', async ({ page }) => {
    test.skip(!CREDS.ownerPin, 'SKIP: set E2E_OWNER_PIN to exercise the owner Overview.')
    const ok = await loginWithPin(page, CREDS.ownerPin)
    test.skip(!ok, 'SKIP: E2E_OWNER_PIN did not authenticate.')

    await page.goto('/overview')
    // Managers reach /overview; workers are redirected to "/" (App.tsx gate).
    await expect(page).toHaveURL(/\/overview$/)
    await expect(page.getByRole('heading', { name: RXO.overview }).first()).toBeVisible()
    console.log('[QA-E2E] Overview manager dashboard rendered.')
  })
})

test.describe('Scenario 9 · Archive renders', () => {
  test('owner opens the Archive (manager-gated archive/trash path)', async ({ page }) => {
    test.skip(!CREDS.ownerPin, 'SKIP: set E2E_OWNER_PIN to exercise the owner Archive.')
    const ok = await loginWithPin(page, CREDS.ownerPin)
    test.skip(!ok, 'SKIP: E2E_OWNER_PIN did not authenticate.')

    await page.goto('/archive')
    // Manager-gated route (App.tsx sends non-managers to "/"): owner stays and the archive renders.
    await expect(page).toHaveURL(/\/archive$/)
    await expect(page.getByRole('heading', { name: RXO.archive }).first()).toBeVisible()
    console.log('[QA-E2E] Archive screen rendered for owner.')
  })
})
