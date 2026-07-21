import { supabase, SUPABASE_KEY, SUPABASE_URL } from '../supabase'
import { warnReadError } from './_shared'
import { classifyTtsResponse, isSupportedPcmFormat, parseStreamSampleRate } from '../aiTtsStream'

// AI-1-UI: «строка-командир» — фронт к развёрнутому бэкенду AI-ассистента владельца (edge
// `ai-assistant`, таблицы ai_messages / ai_proposals, миграция 0057). Бэкенд НЕ трогаем.
// ВАЖНО (сверено с RLS live владельцем-only):
//  • ai_messages: RLS — ТОЛЬКО SELECT, owner-only (org=app.org_id() AND user_id=auth.uid() AND
//    app.is_owner()). INSERT в ai_messages делает ТОЛЬКО edge (service-role) при POST. => с фронта
//    историю мы ТОЛЬКО ЧИТАЕМ, ничего не вставляем.
//  • ai_proposals: RLS — ALL, owner-only (USING+WITH CHECK). Владелец SELECT-ит pending и UPDATE-ит
//    статус (executed/rejected). INSERT предложений делает edge. => с фронта мы select + update.
// Поэтому в этом файле НЕТ НИ ОДНОГО insert в ai_messages/ai_proposals — только select, update
// proposals и вызов edge. Ошибки чтения деградируют мягко в [] (паттерн getMailMessages/warnReadError):
// пустая история / отказ RLS у не-владельца — это НЕ баг экрана.

export type AiRole = 'user' | 'assistant'

export interface AiMessage {
  id: string
  org_id: string
  user_id: string
  role: AiRole
  content: string
  created_at: string
}

export type AiProposalStatus = 'pending' | 'approved' | 'rejected' | 'executed'

export interface AiProposal {
  id: string
  org_id: string
  user_id: string
  action_type: string
  title: string
  payload: Record<string, unknown>
  status: AiProposalStatus
  resolved_by: string | null
  resolved_at: string | null
  result: Record<string, unknown> | null
  created_at: string
}

const AI_MESSAGE_SELECT = 'id, org_id, user_id, role, content, created_at'
const AI_PROPOSAL_SELECT =
  'id, org_id, user_id, action_type, title, payload, status, resolved_by, resolved_at, result, created_at'

// История диалога текущего юзера-владельца, старые сверху (asc) — как лента чата. RLS сама
// ограничивает своим user + owner. error → [] (мягкая деградация, пустая история не баг).
export async function getAiMessages(): Promise<AiMessage[]> {
  const { data, error } = await supabase
    .from('ai_messages')
    .select(AI_MESSAGE_SELECT)
    .order('created_at', { ascending: true })
  if (error) {
    warnReadError('getAiMessages', error)
    return []
  }
  return (data as AiMessage[]) ?? []
}

// Ожидающие предложения ИИ, свежие сверху. RLS ограничивает org + owner. error → [].
export async function getPendingProposals(): Promise<AiProposal[]> {
  const { data, error } = await supabase
    .from('ai_proposals')
    .select(AI_PROPOSAL_SELECT)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
  if (error) {
    warnReadError('getPendingProposals', error)
    return []
  }
  return (data as AiProposal[]) ?? []
}

// error: 'no_key' — особый sentinel (ANTHROPIC_API_KEY не введён в Supabase secrets): UI покажет
// плашку, а не тост. Иначе error — человекочитаемый текст ошибки из ответа edge (тост).
export interface AskAssistantResult {
  reply?: string
  error?: string
}

export type AiExecuteProposalErrorCode = 'ambiguous' | 'not_found'

export interface AiExecuteCandidate {
  id?: string
  name?: string | null
  title?: string | null
  type?: string | null
  role?: string | null
  address?: string | null
  [key: string]: unknown
}

export type AiExecuteProposalResult =
  | { ok: true; result: Record<string, unknown>; raw: Record<string, unknown> }
  | {
      ok: false
      error: AiExecuteProposalErrorCode
      candidates: AiExecuteCandidate[]
      message?: string
      raw?: Record<string, unknown>
    }

export interface AiTtsRequest {
  text: string
  voice?: string
  style?: string
  signal?: AbortSignal
}

export interface AiTtsResult {
  blob: Blob
  mime: string
}

// Достаём текст ошибки из тела ответа edge (FunctionsHttpError несёт Response в error.context) —
// тот же приём, что mail.ts/mailSendErrorText. undefined, если тела нет.
async function functionErrorText(error: unknown): Promise<string | undefined> {
  const context = (error as { context?: { json?: () => Promise<unknown> } } | null)?.context
  if (typeof context?.json !== 'function') return undefined
  try {
    const body = await context.json()
    const raw = (body as { error?: unknown } | null)?.error
    return typeof raw === 'string' && raw.trim() ? raw : undefined
  } catch {
    return undefined
  }
}

// Распознаём ответ «нет ключа» (ANTHROPIC_API_KEY не задан) по тексту ошибки edge — терпимо к
// формулировке (en/ru), чтобы показать понятную плашку вместо сырого текста 500.
function looksLikeNoKey(text: string | undefined): boolean {
  if (!text) return false
  const t = text.toLowerCase()
  return (
    t.includes('anthropic_api_key') ||
    t.includes('api key') ||
    t.includes('api_key') ||
    (t.includes('key') && (t.includes('missing') || t.includes('not set') || t.includes('not configured'))) ||
    t.includes('нет ключ') ||
    t.includes('ключ не')
  )
}

// POST на edge `ai-assistant` {message}. edge задеплоен с verify_jwt=false — он проверяет токен САМ,
// поэтому мы ЯВНО достаём access_token текущей сессии (supabase.auth.getSession) и шлём заголовок
// Authorization: Bearer <token> (Bearer-паттерн как в MAIL-2 mail-send). edge сам вставляет
// user/assistant-строки в ai_messages и pending-строки в ai_proposals — мы после ответа рефетчим
// историю и предложения (ничего не вставляем сами).
export async function askAssistant(message: string): Promise<AskAssistantResult> {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) return { error: 'no_session' }
  const { data, error } = await supabase.functions.invoke('ai-assistant', {
    body: { message },
    headers: { Authorization: `Bearer ${token}` },
  })
  if (error) {
    // На non-2xx supabase-js кладёт ошибку в `error` (data=null); читаем текст edge из тела.
    const fromData = (data as { error?: unknown } | null)?.error
    const text =
      (typeof fromData === 'string' && fromData.trim() ? fromData : undefined) ??
      (await functionErrorText(error)) ??
      (error instanceof Error ? error.message : undefined)
    if (looksLikeNoKey(text)) return { error: 'no_key' }
    return { error: text ?? 'request_failed' }
  }
  // Edge может вернуть 200 с { error } — тоже трактуем как неуспех.
  const dataErr = (data as { error?: unknown } | null)?.error
  if (typeof dataErr === 'string' && dataErr.trim()) {
    if (looksLikeNoKey(dataErr)) return { error: 'no_key' }
    return { error: dataErr }
  }
  const reply = (data as { reply?: unknown } | null)?.reply
  return { reply: typeof reply === 'string' ? reply : undefined }
}

function normalizeExecuteCandidates(value: unknown): AiExecuteCandidate[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((x): x is AiExecuteCandidate => typeof x === 'object' && x !== null)
    .map((x) => x)
}

export async function executeAiProposal(proposalId: string): Promise<AiExecuteProposalResult> {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) throw new Error('no_session')

  const resp = await fetch(`${SUPABASE_URL}/functions/v1/ai-execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_KEY,
    },
    body: JSON.stringify({ proposal_id: proposalId }),
  })
  const body = (await resp.json().catch(() => null)) as Record<string, unknown> | null
  const error = typeof body?.error === 'string' && body.error.trim() ? body.error.trim() : undefined
  if (!resp.ok || error) {
    if (error === 'ambiguous' || error === 'not_found') {
      const message = typeof body?.message === 'string' && body.message.trim() ? body.message.trim() : undefined
      return {
        ok: false,
        error,
        candidates: normalizeExecuteCandidates(body?.candidates),
        message,
        raw: body ?? undefined,
      }
    }
    throw new Error(error ?? `ai_execute_http_${resp.status}`)
  }
  return { ok: true, result: (body?.result as Record<string, unknown> | undefined) ?? body ?? {}, raw: body ?? {} }
}

function base64ToBlob(audioB64: string, mime: string): Blob {
  const binary = atob(audioB64)
  const chunkSize = 8192
  const chunks: ArrayBuffer[] = []
  for (let offset = 0; offset < binary.length; offset += chunkSize) {
    const slice = binary.slice(offset, offset + chunkSize)
    const chunk = new ArrayBuffer(slice.length)
    const bytes = new Uint8Array(chunk)
    for (let i = 0; i < slice.length; i++) bytes[i] = slice.charCodeAt(i)
    chunks.push(chunk)
  }
  return new Blob(chunks, { type: mime })
}

export async function synthesizeAiSpeech({ text, voice, style, signal }: AiTtsRequest): Promise<AiTtsResult> {
  const cleanText = text.trim()
  if (!cleanText) throw new Error('empty_text')
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) throw new Error('no_session')

  const body: Record<string, string> = { text: cleanText }
  if (voice?.trim()) body.voice = voice.trim()
  if (style?.trim()) body.style = style.trim()

  const resp = await fetch(`${SUPABASE_URL}/functions/v1/ai-tts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_KEY,
    },
    body: JSON.stringify(body),
    signal,
  })
  const data = (await resp.json().catch(() => null)) as { audio_b64?: unknown; mime?: unknown; error?: unknown } | null
  const errorText = typeof data?.error === 'string' && data.error.trim() ? data.error : undefined
  if (!resp.ok || errorText) throw new Error(errorText ?? `tts_http_${resp.status}`)
  const audioB64 = typeof data?.audio_b64 === 'string' ? data.audio_b64 : ''
  const mime = typeof data?.mime === 'string' && data.mime.trim() ? data.mime : 'audio/wav'
  if (!audioB64) throw new Error('tts_empty_audio')
  return { blob: base64ToBlob(audioB64, mime), mime }
}

// VOICE-FRONT-STREAM: результат `streamAiSpeech`. Либо прогрессивный PCM-стрим (играем встык по
// мере прихода — первые слова звучат почти сразу), либо целый WAV-фолбэк (edge отдал X-Fallback:full).
export type AiTtsStreamResult =
  | { kind: 'stream'; sampleRate: number; format: string | null; body: ReadableStream<Uint8Array> }
  | { kind: 'fallback'; blob: Blob; mime: string }

// POST на edge `ai-tts-stream` (verify_jwt=true) — тот же Bearer JWT + apikey, что и ai-tts. Различаем
// путь СТРОГО по Content-Type ответа: audio/wav → целый WAV-фолбэк; иначе application/octet-stream →
// сырой PCM16LE mono-стрим (X-Sample-Rate/ X-Audio-Format в заголовках). При non-2xx / неизвестном
// формате / отсутствии тела бросаем ошибку — вызывающий откатится на synthesizeAiSpeech→ai-tts, не
// ломая текущее поведение. Само проигрывание (AudioContext, нарезка/встык) — в AiCommandBar.
export async function streamAiSpeech({ text, voice, style, signal }: AiTtsRequest): Promise<AiTtsStreamResult> {
  const cleanText = text.trim()
  if (!cleanText) throw new Error('empty_text')
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) throw new Error('no_session')

  const body: Record<string, string> = { text: cleanText }
  if (voice?.trim()) body.voice = voice.trim()
  if (style?.trim()) body.style = style.trim()

  const resp = await fetch(`${SUPABASE_URL}/functions/v1/ai-tts-stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_KEY,
    },
    body: JSON.stringify(body),
    signal,
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(errText.trim() ? errText.trim().slice(0, 200) : `tts_stream_http_${resp.status}`)
  }

  const contentType = resp.headers.get('Content-Type')
  if (classifyTtsResponse(contentType) === 'fallback') {
    const blob = await resp.blob()
    return { kind: 'fallback', blob, mime: contentType ?? 'audio/wav' }
  }

  const format = resp.headers.get('X-Audio-Format')
  if (!isSupportedPcmFormat(format)) throw new Error(`tts_stream_bad_format_${format ?? 'none'}`)
  if (!resp.body) throw new Error('tts_stream_no_body')
  return {
    kind: 'stream',
    sampleRate: parseStreamSampleRate(resp.headers.get('X-Sample-Rate')),
    format,
    body: resp.body,
  }
}

// UPDATE статуса предложения (executed/rejected) + resolved_by=auth.uid() + resolved_at=now() +
// опц. result (jsonb). RLS ai_proposals (ALL, owner-only) пускает UPDATE владельца. Мы НЕ делаем
// insert. resolved_by берём из сессии (session.user.id == auth.uid()). Ошибку пробрасываем (throw),
// чтобы UI показал тост и оставил карточку (при executed вызов идёт ПОСЛЕ реального действия).
export async function resolveProposal(
  id: string,
  status: 'executed' | 'rejected',
  result?: Record<string, unknown>,
): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession()
  const patch: Record<string, unknown> = {
    status,
    resolved_by: session?.user?.id ?? null,
    resolved_at: new Date().toISOString(),
  }
  if (result !== undefined) patch.result = result
  const { error } = await supabase.from('ai_proposals').update(patch).eq('id', id)
  if (error) throw error
}
