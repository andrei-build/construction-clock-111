// Construction Clock · create-worker
// Менеджер создаёт работника: auth-пользователь + профиль с PIN (id совпадают — требование RLS).
import { createClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' })

  const url = Deno.env.get('SUPABASE_URL')!
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })

  // Кто зовёт: только менеджерская запись (ДНК §1)
  const authHeader = req.headers.get('Authorization') ?? ''
  const caller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    auth: { persistSession: false }, global: { headers: { Authorization: authHeader } },
  })
  const { data: { user } } = await caller.auth.getUser()
  if (!user) return json(401, { error: 'unauthorized' })
  const { data: me } = await admin.from('profiles').select('id, org_id, name, role').eq('id', user.id).maybeSingle()
  if (!me || !['manager', 'admin', 'owner'].includes(me.role)) return json(403, { error: 'forbidden' })

  let body: { name?: string; pin?: string; role?: string; language?: string }
  try { body = await req.json() } catch { return json(400, { error: 'bad_json' }) }
  const name = (body.name ?? '').trim()
  const pin = (body.pin ?? '').trim()
  const role = body.role ?? 'worker'
  if (!name || !/^[0-9]{4,8}$/.test(pin)) return json(400, { error: 'bad_input' })
  if (!['worker', 'driver', 'subcontractor', 'supervisor', 'manager'].includes(role)) return json(400, { error: 'bad_role' })

  // PIN уникален внутри организации
  const { data: existing } = await admin.from('profiles').select('id, pin_hash').eq('org_id', me.org_id).eq('is_active', true).not('pin_hash', 'is', null)
  for (const p of existing ?? []) {
    if (p.pin_hash === await sha256hex(`${pin}:${p.id}`)) return json(409, { error: 'pin_taken' })
  }

  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email: `w-${crypto.randomUUID()}@workers.cclock.app`,
    email_confirm: true,
  })
  if (cErr || !created?.user) return json(500, { error: 'auth_create_failed' })

  const pinHash = await sha256hex(`${pin}:${created.user.id}`)
  const { data: profile, error: pErr } = await admin.from('profiles').insert({
    id: created.user.id, org_id: me.org_id, name, role,
    pin_hash: pinHash, language: body.language ?? 'en',
  }).select('id, name, role, language').single()
  if (pErr) {
    await admin.auth.admin.deleteUser(created.user.id)
    return json(500, { error: 'profile_create_failed', detail: pErr.message })
  }

  await admin.from('events').insert({
    org_id: me.org_id, event_type: 'worker.created', entity_type: 'profile', entity_id: profile.id,
    actor_id: me.id, actor_name: me.name, actor_role: me.role,
    data: { name, role },
  })

  return json(200, { profile })
})
