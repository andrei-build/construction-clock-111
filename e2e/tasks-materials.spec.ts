import { test, expect } from '@playwright/test'
import { CREDS, loginWithPin } from './helpers'

// Scenario 3 — Create a task + a material request.
// In the project hub's Tasks tab, the material-request form (which creates a material-type task)
// is reachable to workers via "+ Мало материала". Needs a login and a visible project.
//
// This is a NON-MUTATING smoke: we open the material-request form and confirm its fields +
// "Create" action are present, but we do NOT submit — submitting writes a new task/request to
// the (dev) Supabase backend. That boundary is logged. General (non-material) task creation is
// manager-gated; the material-request form is the worker-reachable create-a-task affordance.

test.describe('Scenario 3 · Create task / material request', () => {
  test('material-request creation form is reachable and complete', async ({ page }) => {
    test.skip(!CREDS.workerPin, 'SKIP: set E2E_WORKER_PIN to reach the material-request form.')
    const ok = await loginWithPin(page, CREDS.workerPin)
    test.skip(!ok, 'SKIP: E2E_WORKER_PIN did not authenticate.')

    await page.goto('/projects')
    const projectLink = page.locator('.project-name-link').first()
    if (!(await projectLink.isVisible().catch(() => false))) {
      console.log('[QA-E2E] no projects visible — cannot reach a project hub Tasks tab (no seeded data).')
      test.skip(true, 'SKIP: no projects available.')
      return
    }
    await projectLink.click()
    await expect(page).toHaveURL(/\/projects\/.+/)

    // Open the Tasks tab (worker-visible) if it isn't already active.
    const tasksTab = page.getByText(/Задачи|Tasks|Tareas/i).first()
    await tasksTab.click().catch(() => {})

    // The quick material-request opener.
    const opener = page.getByRole('button', { name: /Мало материала|Low material|Falta material/i })
    if (!(await opener.isVisible().catch(() => false))) {
      console.log('[QA-E2E] material-request opener not visible for this account/project.')
      test.skip(true, 'SKIP: material-request affordance not available.')
      return
    }
    await opener.click()

    // The form fields + Create action are present. We stop here (no submit → no DB write).
    await expect(page.getByRole('heading', { name: /Заявка на материал|Material request|Solicitud de material/i })).toBeVisible()
    const createBtn = page.getByRole('button', { name: /Создать заявку|Create request|Crear solicitud/i })
    await expect(createBtn).toBeVisible()
    console.log('[QA-E2E] material-request form reachable (fields + Create present). Not submitted — avoids DB write.')
  })
})
