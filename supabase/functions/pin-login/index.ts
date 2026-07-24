// Construction Clock · pin-login
// Вход работника по PIN: rate-limit (ДНК §2 п.12) → поиск профиля → выпуск сессии через magiclink token.
// verify_jwt=false: это публичная точка входа, собственная аутентификация по PIN + защита от перебора.
// v12 (17.07, Бета-5): учитывает profiles.pin_enabled (0060) — выключенный PIN не пускает. Остальное без изменений.
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

  let body: { org_slug?: string; pin?: string }
  try { body = await req.json() } catch { return json(400, { error: 'bad_json' }) }
  const orgSlug = (body.org_slug ?? '').trim().toLowerCase()
  const pin = (body.pin ?? '').trim()
  if (!orgSlug || !/^[0-9]{4,8}$/.test(pin)) return json(400, { error: 'bad_input' })

  const url = Deno.env.get('SUPABASE_URL')!
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  const keyHash = await sha256hex(`${ip}:${orgSlug}`)

  // Анти-перебор: 5 неудач → блок на 15 минут
  const { data: rl } = await admin.from('pin_login_rate_limits').select('*').eq('key_hash', keyHash).maybeSingle()
  if (rl?.locked_until && new Date(rl.locked_until) > new Date()) {
    return json(429, { error: 'locked', until: rl.locked_until })
  }

  const fail = async () => {
    const count = (rl?.fail_count ?? 0) + 1
    await admin.from('pin_login_rate_limits').upsert({
      key_hash: keyHash,
      fail_count: count,
      first_fail_at: rl?.first_fail_at ?? new Date().toISOString(),
      locked_until: count >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    return json(401, { error: 'invalid_credentials' })
  }

  const { data: org } = await admin.from('organizations').select('id, name').eq('slug', orgSlug).maybeSingle()
  if (!org) return await fail()

  const { data: profiles } = await admin
    .from('profiles')
    .select('id, name, role, language, pin_hash')
    .eq('org_id', org.id).eq('is_active', true).eq('pin_enabled', true).is('deleted_at', null).not('pin_hash', 'is', null)
  let match: { id: string; name: string; role: string; language: string } | null = null
  for (const p of profiles ?? []) {
    if (p.pin_hash === await sha256hex(`${pin}:${p.id}`)) { match = p; break }
  }
  if (!match) return await fail()

  // Сброс счётчика неудач
  if (rl) await admin.from('pin_login_rate_limits').delete().eq('key_hash', keyHash)

  // Сессия: у работника есть auth-пользователь с тем же id (создаётся при заведении работника)
  const { data: authUser, error: uErr } = await admin.auth.admin.getUserById(match.id)
  if (uErr || !authUser?.user?.email) return json(500, { error: 'no_auth_user' })
  const { data: link, error: lErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email: authUser.user.email })
  if (lErr || !link?.properties?.hashed_token) return json(500, { error: 'link_failed' })
  const anon = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { auth: { persistSession: false } })
  const { data: sess, error: vErr } = await anon.auth.verifyOtp({ type: 'email', token_hash: link.properties.hashed_token })
  if (vErr || !sess?.session) return json(500, { error: 'session_failed' })

  // Событие входа — в журнал (ДНК: каждое действие прослеживаемо)
  await admin.from('events').insert({
    org_id: org.id, event_type: 'auth.pin_login', entity_type: 'profile', entity_id: match.id,
    actor_id: match.id, actor_name: match.name, actor_role: match.role, ip: ip === 'unknown' ? null : ip,
    user_agent: req.headers.get('user-agent'),
  })

  return json(200, {
    session: { access_token: sess.session.access_token, refresh_token: sess.session.refresh_token },
    profile: match,
    org: { id: org.id, name: org.name },
  })
})
