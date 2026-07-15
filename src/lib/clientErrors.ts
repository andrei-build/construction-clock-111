// A8: silent client-side error telemetry. Uncaught errors and unhandled promise
// rejections are recorded into public.client_errors so production failures are visible
// to the owner. This is invisible to the user — no UI, no toast, no behavior change.
//
// RLS (ce_insert) only permits an insert for an AUTHENTICATED user whose row carries
// org_id = app.org_id() AND profile_id = auth.uid(). We therefore only ever insert when
// a profile is loaded (setClientErrorContext), and we set org_id/profile_id from it. On
// the login screen (no profile) we skip silently — an insert there would fail RLS anyway.
//
// Mirrors the setFinanceCacheAllowed precedent in offlineReadCache.ts: a module-level
// context that auth.tsx sets when the profile loads and clears on logout/session-loss.

import { supabase } from './supabase'

// The current authenticated context, or null when nobody is logged in. auth.tsx keeps this
// in sync alongside its setFinanceCacheAllowed(...) calls.
let ctx: { org_id: string; id: string } | null = null

export function setClientErrorContext(profile: { org_id: string; id: string } | null): void {
  ctx = profile ? { org_id: profile.org_id, id: profile.id } : null
}

// Tiny stable djb2 hash over the stack string, hex. Lets us dedupe/throttle recurring
// errors without a dependency and without storing the full stack.
function hashStack(input: string): string {
  let h = 5381
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(16)
}

// Per-stack_hash throttle: the same error is recorded at most once per minute so a tight
// error loop can't flood the table.
const THROTTLE_MS = 60_000
const lastSent = new Map<string, number>()

async function report(message: string, stack: string): Promise<void> {
  try {
    // No logged-in profile → the insert would fail RLS. Skip silently.
    if (!ctx) return

    const stack_hash = hashStack(stack || message)
    const now = Date.now()
    const prev = lastSent.get(stack_hash)
    if (prev !== undefined && now - prev < THROTTLE_MS) return
    lastSent.set(stack_hash, now)

    await supabase.from('client_errors').insert({
      org_id: ctx.org_id,
      profile_id: ctx.id,
      message: String(message).slice(0, 500),
      stack_hash,
      url: location.href,
      user_agent: navigator.userAgent,
    })
  } catch {
    // Telemetry must never raise or loop: swallow everything, and don't console.error here
    // (that could re-enter the error listener).
  }
}

let initialized = false

export function initClientErrorReporting(): void {
  if (initialized) return
  initialized = true
  if (typeof window === 'undefined') return

  window.addEventListener('error', (event) => {
    // Observe only — never preventDefault / change app behavior.
    void report(event.message || String(event.error), event.error?.stack ?? '')
  })

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    const message = reason?.message ?? String(reason)
    void report(message, reason?.stack ?? '')
  })
}
