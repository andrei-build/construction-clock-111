import { test, expect } from '@playwright/test'
import { RX, CREDS, loginWorkerReady } from './helpers'

// Scenario 5 — Project hub opens.
// Needs a login (worker PIN is enough — workers can open a project hub) and at least one
// project the account can see. Self-skips if no PIN or no projects.

test.describe('Scenario 5 · Project hub', () => {
  test('opening a project shows the project hub with its tabs', async ({ page }) => {
    test.skip(!CREDS.workerPin, 'SKIP: set E2E_WORKER_PIN to open a project hub.')
    const ok = await loginWorkerReady(page, CREDS.workerPin)
    test.skip(!ok, 'SKIP: E2E_WORKER_PIN did not authenticate / could not pass the GPS-consent gate.')

    await page.goto('/projects')
    await expect(page.getByRole('heading', { name: RX.projectsTitle })).toBeVisible()

    const projectLink = page.locator('.project-name-link').first()
    const hasProject = await projectLink.isVisible().catch(() => false)
    if (!hasProject) {
      console.log('[QA-E2E] no projects visible — cannot open a hub (no seeded data).')
      test.skip(true, 'SKIP: no projects available to open.')
      return
    }

    await projectLink.click()
    await expect(page).toHaveURL(/\/projects\/.+/)

    // The hub renders its tab strip; "Overview" and "Tasks" are visible to workers.
    await expect(page.getByText(/Обзор|Overview|Resumen/i).first()).toBeVisible()
    await expect(page.getByText(/Задачи|Tasks|Tareas/i).first()).toBeVisible()
    console.log('[QA-E2E] project hub opened with tab strip visible.')
  })
})
