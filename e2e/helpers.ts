import { type Page, type Locator, expect } from '@playwright/test'

// Shared helpers for the QA-E2E smoke suite.
//
// The login screen (src/screens/Login.tsx) is language-driven (default "ru"). To stay resilient
// we match text with multi-language regexes and lean on structural/role selectors where possible.

// --- language-agnostic text matchers (ru | en | es) -----------------------------------------
export const RX = {
  enterPin: /Введите PIN|Enter PIN|Ingrese PIN/i,
  workerTab: /Работник|Worker|Trabajador/i,
  officeTab: /Офис|Office|Oficina|Владелец|Owner|Dueño/i,
  signIn: /Войти|Sign in|Entrar/i,
  invalidCreds: /Неверные данные входа|Invalid credentials|Credenciales inválidas/i,
  checkinTitle: /Отметка|Check-?In|Marcar/i,
  selectProject: /Выбери проект|Select project|Elige proyecto/i,
  notOnShift: /Не на смене|Not on shift|Fuera de turno/i,
  checkInBtn: /ПРИШЁЛ|CHECK IN|ENTRADA/i,
  offlineBanner: /Нет связи|offline|Sin conexión/i,
  payrollLocked: /только финансам|only available to finance|solo están disponibles para finanzas/i,
  payDraft: /Черновик зарплаты|Draft payroll|Nómina preliminar/i,
  projectsTitle: /Проекты|Projects|Proyectos/i,
}

// The PIN keypad — the definitive "we are on the login screen" landmark. Digit glyphs are
// language-independent.
export function keypad(page: Page): Locator {
  return page.getByRole('button', { name: '1', exact: true })
}

// Env-provided credentials for the login-gated scenarios.
export const CREDS = {
  workerPin: process.env.E2E_WORKER_PIN?.trim() || '',
  ownerPin: process.env.E2E_OWNER_PIN?.trim() || '',
  officeEmail: process.env.E2E_OFFICE_EMAIL?.trim() || '',
  officePassword: process.env.E2E_OFFICE_PASSWORD || '',
}

/**
 * Type a PIN on the keypad. The login screen auto-attempts login once the PIN reaches 4 digits,
 * and while an attempt is in flight `pressKey` ignores taps (busy guard). So after the 4th digit
 * we pace the remaining taps and let each in-flight attempt settle before the next tap.
 */
export async function typePin(page: Page, pin: string): Promise<void> {
  await expect(keypad(page)).toBeVisible()
  for (let i = 0; i < pin.length; i++) {
    await page.getByRole('button', { name: pin[i], exact: true }).click()
    if (i >= 3) await page.waitForTimeout(700) // let the auto-attempt for >=4 digits settle
  }
}

/**
 * Log in with a worker/office PIN. Returns true if the app was reached (login screen gone),
 * false if the attempt was rejected. Never throws on a wrong PIN so callers can skip cleanly.
 */
export async function loginWithPin(page: Page, pin: string): Promise<boolean> {
  await page.goto('/')
  // Ensure we're on the worker/PIN tab.
  const worker = page.getByRole('button', { name: RX.workerTab })
  if (await worker.isVisible().catch(() => false)) await worker.click()
  await typePin(page, pin)
  // Success = the "Enter PIN" prompt is gone. Give the session exchange a moment.
  try {
    await expect(page.getByText(RX.enterPin)).toBeHidden({ timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

/**
 * Log in via the office (email/password) tab. Returns true on success.
 */
export async function loginWithEmail(page: Page, email: string, password: string): Promise<boolean> {
  await page.goto('/')
  await page.getByRole('button', { name: RX.officeTab }).click()
  await page.locator('input[type="email"]').fill(email)
  await page.locator('input[type="password"]').fill(password)
  await page.getByRole('button', { name: RX.signIn }).click()
  try {
    await expect(page.getByText(RX.enterPin)).toBeHidden({ timeout: 10_000 })
    // Also make sure we didn't just land back on the office form with an error.
    await expect(page.getByText(RX.invalidCreds)).toHaveCount(0)
    return true
  } catch {
    return false
  }
}
