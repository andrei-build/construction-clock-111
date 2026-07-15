import { defineConfig, devices } from '@playwright/test'

// QA-E2E: smoke suite driven against a real production build served by `vite preview`.
// We build once and preview on a fixed port; Playwright boots that server via `webServer`.
//
// Notes for maintainers:
// - The app talks to a DEV Supabase backend (src/lib/supabase.ts → gzjfjszfdnmaazursppx).
//   We NEVER touch the live Check Time DB. The deterministic specs here don't mutate data;
//   the login-gated specs only read/observe UI and are skipped unless PINs are provided.
// - Service workers are blocked so the PWA cache can't interfere with offline emulation.
// - Login-gated scenarios need a real PIN we cannot obtain deterministically. Provide them
//   via env to exercise those flows (otherwise they self-skip with a clear reason):
//     E2E_WORKER_PIN   — a plain worker PIN (check-in, project hub, offline banner, tasks)
//     E2E_OWNER_PIN    — an owner/finance PIN (payroll visible)
//   Optional office (email) login for the owner side instead of a PIN:
//     E2E_OFFICE_EMAIL / E2E_OFFICE_PASSWORD

const PORT = Number(process.env.E2E_PORT ?? 4173)
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: '.',
  // Keep run artifacts (traces on failure) contained under e2e/ and out of the repo root.
  outputDir: './test-results',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    // Block the service worker (public/sw.js) so offline emulation is driven purely by
    // context.setOffline and navigator.onLine, not by cached responses.
    serviceWorkers: 'block',
    // Pre-grant geolocation so the check-in screen never blocks on a permission prompt.
    permissions: ['geolocation'],
    geolocation: { latitude: 47.6062, longitude: -122.3321 },
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    // Build once, then preview the built assets. reuseExistingServer lets a locally
    // running `npm run preview` be reused instead of rebuilding on every invocation.
    command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
    url: BASE_URL,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
