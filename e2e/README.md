# QA-E2E — Playwright smoke suite

End-to-end smoke tests that drive a **production build served by `vite preview`** (not the dev
server). Playwright builds once and boots the preview via its `webServer` config.

## Run

```bash
npm run build            # sanity: the app still builds
npx playwright install   # one-time: download browsers
npm run e2e              # build + preview + run the suite
```

## Scenarios

| # | Spec | What it checks | Runs without credentials? |
|---|------|----------------|---------------------------|
| 1 | `login.spec.ts` | App boots to PIN login; tab switch; **bad credentials rejected**; wrong PIN grants no access; (valid PIN → app, gated) | ✅ deterministic (valid-PIN case gated) |
| 2 | `checkin.spec.ts` | Worker reaches the check-in screen and can arm check-in | ⏭️ gated (needs worker PIN) |
| 3 | `tasks-materials.spec.ts` | Material-request creation form is reachable + complete | ⏭️ gated |
| 4 | `payroll-visibility.spec.ts` | Payroll **visible to finance**, **not to a worker** (role gate) | ⏭️ gated |
| 5 | `project-hub.spec.ts` | Opening a project shows the hub + tabs | ⏭️ gated |
| 6 | `offline-banner.spec.ts` | `context.setOffline(true)` shows the offline banner | ⏭️ gated |

## Why some scenarios self-skip

Login is by PIN against a **dev** Supabase backend, and we have no deterministic PIN or seeded
data. Those scenarios `test.skip()` with a clear reason instead of flaking red. Provide credentials
via env to exercise them:

| Env var | Purpose |
|---------|---------|
| `E2E_WORKER_PIN` | Plain-worker PIN → check-in, project hub, material request, offline banner, worker payroll gate |
| `E2E_OWNER_PIN` | Owner/finance PIN → payroll is visible |
| `E2E_OFFICE_EMAIL` / `E2E_OFFICE_PASSWORD` | Office (email) login for the owner side, instead of a PIN |
| `E2E_PORT` | Preview port (default `4173`) |

## Safety

- Never touches the live Check Time DB. The app points at the dev project
  `gzjfjszfdnmaazursppx` (see `src/lib/supabase.ts`); these tests only read/observe UI.
- The gated flows are **non-mutating**: they open forms and arm actions but do not submit
  check-ins, tasks, or material requests (each such boundary is `console.log`-ged during the run).
- Service workers are blocked so the PWA cache can't skew offline emulation.
