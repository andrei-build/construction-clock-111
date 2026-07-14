// Web-push notifications — client helpers (F.. push). Backend is an edge function
// `push-send` + table `push_subscriptions` (RLS: user owns own rows). This module owns
// browser subscription lifecycle (subscribe/unsubscribe) and the fire-and-forget invoke
// that asks the backend to deliver a push to a recipient profile.
//
// Everything degrades gracefully when the browser has no push support (iOS Safari in a
// browser tab, old browsers): isPushSupported() gates the UI, and notify* never throws
// into the caller's send path.

import { supabase } from './supabase'
import type { Profile } from './types'

// Public VAPID key — safe to embed (it is the application server's public identity).
export const VAPID_PUBLIC_KEY =
  'BFGAvlEMecMow-VQwmgUpPMGQJAX8JtbKblCguEd6zGUxAtLPbBdYxdjdQtSnqQqgtSjEAPh-mTXO4J_IJwqftw'

// Push is only usable when the SW + PushManager + Notification APIs all exist. On iOS this
// is only true for an installed PWA (home-screen), so a Safari tab reports false → the UI
// shows the "install to home screen" hint instead of an unusable toggle.
export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

// VAPID key is base64url; PushManager.subscribe wants a Uint8Array.
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  // Back the view with a concrete ArrayBuffer so applicationServerKey (BufferSource) accepts it.
  const output = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i)
  return output
}

// Subscription keys come back as ArrayBuffers; the backend stores them base64.
function arrayBufferToBase64(buffer: ArrayBuffer | null): string {
  if (!buffer) return ''
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

// The current browser push subscription for this device (null when none / unsupported).
export async function getExistingSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null
  try {
    const reg = await navigator.serviceWorker.ready
    return await reg.pushManager.getSubscription()
  } catch {
    return null
  }
}

// Ask permission, subscribe this device, and upsert the row in push_subscriptions.
// Throws 'push_unsupported' / 'push_permission_denied' so the UI can react.
export async function enablePush(profile: Profile): Promise<PushSubscription> {
  if (!isPushSupported()) throw new Error('push_unsupported')

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('push_permission_denied')

  const reg = await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    })
  }

  const endpoint = sub.endpoint
  const p256dh = arrayBufferToBase64(sub.getKey('p256dh'))
  const auth = arrayBufferToBase64(sub.getKey('auth'))

  // Endpoint is unique per device. RLS scopes SELECT to our own rows, so this only finds
  // a row we own: if it was revoked (user turned push off then on again) reactivate it and
  // refresh the keys instead of inserting a duplicate; otherwise insert a fresh row.
  const { data: existing } = await supabase
    .from('push_subscriptions')
    .select('id, revoked_at')
    .eq('profile_id', profile.id)
    .eq('endpoint', endpoint)
    .maybeSingle()

  if (existing) {
    const { error } = await supabase
      .from('push_subscriptions')
      .update({ p256dh, auth, user_agent: navigator.userAgent, revoked_at: null })
      .eq('id', existing.id)
    if (error) throw error
  } else {
    const { error } = await supabase.from('push_subscriptions').insert({
      profile_id: profile.id,
      endpoint,
      p256dh,
      auth,
      user_agent: navigator.userAgent,
    })
    if (error) throw error
  }

  return sub
}

// Unsubscribe this device and mark our row revoked (soft delete keeps history for the backend).
export async function disablePush(profile: Profile): Promise<void> {
  if (!isPushSupported()) return

  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  const endpoint = sub?.endpoint

  if (sub) {
    try {
      await sub.unsubscribe()
    } catch {
      // Best-effort: even if the browser unsubscribe fails, still revoke server-side below.
    }
  }

  if (endpoint) {
    const { error } = await supabase
      .from('push_subscriptions')
      .update({ revoked_at: new Date().toISOString() })
      .eq('profile_id', profile.id)
      .eq('endpoint', endpoint)
    if (error) throw error
  }
}

// ── Delivery (fire-and-forget) ──────────────────────────────────────────────────────────
// Notification copy is localized to the recipient's language when known (falls back to ru).
type PushLang = 'ru' | 'en' | 'es'

const NEW_MESSAGE_TITLE: Record<PushLang, string> = {
  ru: 'Новое сообщение',
  en: 'New message',
  es: 'Nuevo mensaje',
}

function pushLang(l?: string | null): PushLang {
  return l === 'en' || l === 'es' ? l : 'ru'
}

// Ask the backend to deliver a "new message" push to a recipient. NEVER blocks or throws
// into the message-send path — errors are swallowed to the console (fire-and-forget).
export function notifyMessagePush(
  recipientProfileId: string,
  senderName: string,
  body: string,
  lang?: string | null,
  url = '/messages',
): void {
  try {
    const title = `${NEW_MESSAGE_TITLE[pushLang(lang)]}: ${senderName}`
    void supabase.functions
      .invoke('push-send', {
        body: {
          recipient_profile_id: recipientProfileId,
          title,
          body: (body ?? '').slice(0, 100),
          url,
        },
      })
      .catch((err) => {
        console.error('push-send failed', err)
      })
  } catch (err) {
    console.error('push-send failed', err)
  }
}
