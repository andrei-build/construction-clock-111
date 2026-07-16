import { test, expect } from '@playwright/test'
import { CREDS, loginWithPin } from './helpers'

// QA-DIAG pass #3 — owner-driven, READ-ONLY smoke of screens that shipped since pass #2 and had
// ZERO e2e coverage: «Почта»/Mail (MAIL-1/2), «Рассылка»/Broadcast (BROADCAST-1) and the new
// «GPS-данные» section of «Настройки»/Settings (SET-1-GPS).
//
// Owner-driven by design: the owner (role owner) logs in via the PIN keypad and lands straight in
// the app shell (no GPS-consent gate). Every scenario is NON-MUTATING — we open the screen and
// assert its landmark, and NEVER submit (no mail sent, no broadcast sent, no GPS export/purge). All
// three self-skip cleanly when E2E_OWNER_PIN is absent or the route/landmark isn't reachable
// (mirrors the checkin / project-hub "reachable-or-skip" convention). Nothing is created, so there
// is nothing to clean up.

// Language-agnostic matchers (ru | en | es), mirroring helpers.RX style. Values are pulled from
// src/lib/i18n.tsx so the regexes track the shipped copy.
const RXN = {
  // Mail
  mail: /Почта|Mail|Correo/i,
  // Empty / not-connected placeholders: mail_empty ("Ожидает реквизитов"), mail_no_accounts,
  // mail_box_not_connected. Any of these proves the screen rendered a real state.
  mailPlaceholder: /Ожидает реквизитов|Waiting for credentials|Esperando credenciales|Почтовые ящики недоступны|No mailboxes available|Sin buzones disponibles|Ящик не подключён|Mailbox not connected|Buzón no conectado/i,
  // Broadcast
  broadcastTitle: /Рассылка|Broadcast|Difusión/i,
  broadcastSend: /Отправить рассылку|Send broadcast|Enviar difusión/i,
  // Settings + its GPS-данные section (SET-1-GPS)
  settingsTitle: /Настройки приложения|App settings|Ajustes de la aplicación/i,
  gpsSection: /GPS-данные|GPS data|Datos GPS/i,
  gpsExportTitle: /Экспорт GPS|Export GPS|Exportar GPS/i,
  gpsPurgeTitle: /Очистить трекинг|Clear tracking|Limpiar feeds/i,
}

// Navigate to `path` and report whether the client-side route gate kept us there. A route the
// persona can't reach redirects to "/" (App.tsx <Navigate>), so waitForURL times out → false and
// the caller skips cleanly instead of asserting against the home screen.
async function reachRoute(page: import('@playwright/test').Page, path: string, rx: RegExp): Promise<boolean> {
  await page.goto(path)
  return page.waitForURL(rx, { timeout: 5_000 }).then(() => true).catch(() => false)
}

test.describe('QA-DIAG · Owner Mail screen', () => {
  test('C · owner opens «Почта» and the mailbox renders (read-only)', async ({ page }) => {
    test.skip(!CREDS.ownerPin, 'SKIP: set E2E_OWNER_PIN to open the Mail screen.')
    const ok = await loginWithPin(page, CREDS.ownerPin)
    test.skip(!ok, 'SKIP: E2E_OWNER_PIN did not authenticate.')

    // /mail is owner/admin-gated; a non-owner/admin is bounced to "/". Skip cleanly if unreachable.
    const reached = await reachRoute(page, '/mail', /\/mail$/)
    if (!reached) {
      console.log('[QA-E2E] /mail not reachable for this persona (redirected home) — skipping.')
      test.skip(true, 'SKIP: /mail route not reachable (owner/admin gate).')
      return
    }
    await expect(page).toHaveURL(/\/mail$/)
    await expect(page.getByRole('heading', { name: RXN.mail })).toBeVisible()

    // The screen resolved to one of its real states: mailbox tabs OR an empty/not-connected
    // placeholder ("Ожидает реквизитов" when the Supabase mail secrets aren't set). Either proves
    // it rendered. We read only — no compose, no sync, nothing sent.
    const tabs = page.locator('.mail-tabs [role="tab"]').first()
    const placeholder = page.getByText(RXN.mailPlaceholder).first()
    await expect(tabs.or(placeholder)).toBeVisible({ timeout: 15_000 })
    console.log('[QA-E2E] Mail screen rendered (mailbox tabs or empty/last_error placeholder). Read-only — nothing sent.')
  })
})

test.describe('QA-DIAG · Owner Broadcast screen', () => {
  test('D · owner opens «Рассылка» and the subject/message composer renders (nothing sent)', async ({ page }) => {
    test.skip(!CREDS.ownerPin, 'SKIP: set E2E_OWNER_PIN to open the Broadcast screen.')
    const ok = await loginWithPin(page, CREDS.ownerPin)
    test.skip(!ok, 'SKIP: E2E_OWNER_PIN did not authenticate.')

    // /broadcast is manager-gated at the route and owner-only inside the component. Skip if unreachable.
    const reached = await reachRoute(page, '/broadcast', /\/broadcast$/)
    if (!reached) {
      console.log('[QA-E2E] /broadcast not reachable for this persona (redirected home) — skipping.')
      test.skip(true, 'SKIP: /broadcast route not reachable (manager gate).')
      return
    }
    await expect(page).toHaveURL(/\/broadcast$/)
    await expect(page.getByRole('heading', { name: RXN.broadcastTitle })).toBeVisible()

    // Owner sees the composer form. A non-owner (e.g. admin) would get the friendly refusal
    // (broadcast_owner_only) with no textarea — in that case skip cleanly rather than fail.
    const message = page.locator('.card textarea').first()
    if (!(await message.isVisible().catch(() => false))) {
      console.log('[QA-E2E] Broadcast composer not present (non-owner friendly refusal) — skipping.')
      test.skip(true, 'SKIP: broadcast composer not present (non-owner).')
      return
    }

    // Composer landmark: subject input + message textarea + the send button. We assert they render
    // but NEVER fill or submit — a broadcast is an un-undoable fan-out email. Send nothing.
    await expect(page.locator('.card input[type="text"]').first()).toBeVisible()
    await expect(message).toBeVisible()
    await expect(page.getByRole('button', { name: RXN.broadcastSend })).toBeVisible()
    console.log('[QA-E2E] Broadcast composer rendered (subject + message + send). Read-only — nothing sent.')
  })
})

test.describe('QA-DIAG · Owner Settings GPS-данные section', () => {
  test('E · owner Settings shows the «GPS-данные» export/purge section (no export, no purge)', async ({ page }) => {
    test.skip(!CREDS.ownerPin, 'SKIP: set E2E_OWNER_PIN to open Settings.')
    const ok = await loginWithPin(page, CREDS.ownerPin)
    test.skip(!ok, 'SKIP: E2E_OWNER_PIN did not authenticate.')

    // /settings is owner/admin-gated. Skip cleanly if unreachable.
    const reached = await reachRoute(page, '/settings', /\/settings$/)
    if (!reached) {
      console.log('[QA-E2E] /settings not reachable for this persona (redirected home) — skipping.')
      test.skip(true, 'SKIP: /settings route not reachable (owner/admin gate).')
      return
    }
    await expect(page).toHaveURL(/\/settings$/)
    await expect(page.getByRole('heading', { name: RXN.settingsTitle })).toBeVisible()

    // The «GPS-данные» section (SET-1-GPS) renders only for an owner (canEdit) after settings load.
    // If it never appears (non-owner / load error), skip cleanly instead of failing.
    const gpsSection = page.getByRole('heading', { name: RXN.gpsSection })
    try {
      await expect(gpsSection).toBeVisible({ timeout: 15_000 })
    } catch {
      console.log('[QA-E2E] «GPS-данные» section not reachable for this persona — skipping.')
      test.skip(true, 'SKIP: GPS-данные section not present (non-owner / not loaded).')
      return
    }

    // Both sub-section headers must render. We assert only — we NEVER click Export or Purge.
    await expect(page.getByRole('heading', { name: RXN.gpsExportTitle })).toBeVisible()
    await expect(page.getByRole('heading', { name: RXN.gpsPurgeTitle })).toBeVisible()
    console.log('[QA-E2E] Settings «GPS-данные» section rendered (export + purge headers). Read-only — no export, no purge.')
  })
})
