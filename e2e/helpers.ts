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
  // The mandatory WA-law GPS-consent gate that workers/drivers hit before the app (GpsConsent.tsx).
  gpsConsentTitle: /Согласие на GPS|GPS tracking consent|Consentimiento de rastreo GPS/i,
  gpsConsentSign: /Подписываю|I agree|Acepto/i,
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

// The authenticated app shell (App.tsx → `<div className="app">`) and the GPS-consent gate
// (GpsConsent.tsx → `<div className="screen safety-screen">`) are the two genuine post-login
// landmarks. A worker/driver without an active consent lands on the consent gate FIRST (WA law);
// they are still logged in — the app shell only mounts once consent is signed. Waiting on the
// login prompt merely disappearing is not enough (the profile/persona may still be settling and
// the consent gate briefly shows its own spinner), so callers must wait for one of these.
export function postLoginLandmark(page: Page): Locator {
  return page.locator('.app, .safety-screen')
}

/**
 * Log in with a worker/office PIN. Returns true once a real post-login landmark is reached
 * (the authed app shell OR the GPS-consent gate), false if the attempt was rejected. Never throws
 * on a wrong PIN so callers can skip cleanly.
 */
export async function loginWithPin(page: Page, pin: string): Promise<boolean> {
  await page.goto('/')
  // Ensure we're on the worker/PIN tab.
  const worker = page.getByRole('button', { name: RX.workerTab })
  if (await worker.isVisible().catch(() => false)) await worker.click()
  await typePin(page, pin)
  // First: the "Enter PIN" prompt must be gone (session exchange happened).
  try {
    await expect(page.getByText(RX.enterPin)).toBeHidden({ timeout: 10_000 })
  } catch {
    return false
  }
  // Then wait for a genuine landmark so callers don't race the still-mounting persona/gate.
  try {
    await expect(postLoginLandmark(page).first()).toBeVisible({ timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

/**
 * Pass the WA-law GPS-consent gate if it is showing. Workers/drivers without an active
 * `worker_location_consents` row are held here before the app mounts. Signing is a one-time,
 * idempotent onboarding step (the row persists with `revoked_at IS NULL`), so once signed the gate
 * never reappears on later runs. Draws a short signature stroke and submits. Returns true if it
 * signed the gate, false if the gate was not present (already consented / non-field role).
 */
export async function signGpsConsentIfPresent(page: Page): Promise<boolean> {
  const heading = page.getByRole('heading', { name: RX.gpsConsentTitle })
  if (!(await heading.isVisible().catch(() => false))) return false

  const canvas = page.locator('canvas.signature-canvas')
  await canvas.waitFor({ state: 'visible' })
  const box = await canvas.boundingBox()
  if (!box) throw new Error('GPS-consent signature canvas has no bounding box')

  // Draw a small stroke across the canvas (pointer events → beginSignature/drawSignature/end).
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.5)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.35)
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.6)
  await page.mouse.up()

  const signBtn = page.getByRole('button', { name: RX.gpsConsentSign })
  await expect(signBtn).toBeEnabled()
  await signBtn.click()

  // Success = the gate is gone and the app shell mounts. A stuck gate (upload/RLS failure) is a
  // real bug; we surface it by returning false so the caller can skip/report rather than hang.
  try {
    await expect(heading).toBeHidden({ timeout: 20_000 })
    await expect(page.locator('.app').first()).toBeVisible({ timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

/**
 * Log in as the worker AND get past the GPS-consent gate so the app shell is reachable. Returns
 * true only when the authed app is actually mounted. Consolidates the worker-flow setup shared by
 * the check-in, project-hub, offline-banner and worker-payroll specs.
 */
export async function loginWorkerReady(page: Page, pin: string): Promise<boolean> {
  const ok = await loginWithPin(page, pin)
  if (!ok) return false
  // Sign the consent if the gate is up; either way, confirm the app shell is present.
  const signed = await signGpsConsentIfPresent(page)
  if (signed) return true
  return await page.locator('.app').first().isVisible().catch(() => false)
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
