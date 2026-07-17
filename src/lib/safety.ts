// SAFETY-2 (закон Андрея 17.07): недельный ритм подписи свода ТБ + жёсткий гейт на начало смены.
// Весь конфиг ТБ (текст свода на 3 языках, его версия, флаг жёсткого гейта) живёт в
// app_settings.settings (jsonb) — БЕЗ новой таблицы/колонки. Эти чистые функции читают его из
// AppSettings.settings и вычисляют актуальность подписи (без сети/React), поэтому переиспользуются
// и на экране прихода (CheckIn), и в реестрах (Consents/WorkerDetail), и в редакторе (OwnerSettings).
import type { AppSettings } from './types'

export type SafetyLang = 'ru' | 'en' | 'es'

// Свод ТБ, сохранённый владельцем. version — строка, попадающая в safety_acknowledgements.doc_version.
export interface SafetyDocData {
  version: string
  text_ru: string
  text_en: string
  text_es: string
  updated_at: string
}

// Подпись ТБ действует НЕДЕЛЮ: актуальна, если на текущей версии свода И подписана не позже 7 дней.
export const SAFETY_ACK_TTL_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

type SettingsLike = { settings?: Record<string, unknown> | null } | AppSettings | null | undefined

function settingsBag(s: SettingsLike): Record<string, unknown> {
  return (s?.settings ?? {}) as Record<string, unknown>
}

// Свод ТБ из настроек, или null — если владелец ещё не сохранял свой текст (тогда действует дефолт).
export function readSafetyDoc(s: SettingsLike): SafetyDocData | null {
  const doc = settingsBag(s).safety_doc as Partial<SafetyDocData> | undefined
  if (!doc || typeof doc.version !== 'string') return null
  return {
    version: doc.version,
    text_ru: typeof doc.text_ru === 'string' ? doc.text_ru : '',
    text_en: typeof doc.text_en === 'string' ? doc.text_en : '',
    text_es: typeof doc.text_es === 'string' ? doc.text_es : '',
    updated_at: typeof doc.updated_at === 'string' ? doc.updated_at : '',
  }
}

// Текущая версия свода. Нет своего свода → 'v1' (совпадает с историческим хардкодом doc_version в
// storage.uploadSafetySignature) — уже собранные подписи v1 остаются актуальными, пока владелец не
// отредактирует текст (тогда версия сменится и потребуется переподпись).
export function currentSafetyVersion(s: SettingsLike): string {
  return readSafetyDoc(s)?.version ?? 'v1'
}

// Жёсткий гейт активен ТОЛЬКО при явном true. Отсутствует/false → clock-in НЕ меняется (e2e/бригада).
export function isSafetyGateEnforced(s: SettingsLike): boolean {
  return settingsBag(s).safety_gate_enforced === true
}

// Текст свода на языке: свой сохранённый (если непустой) — он; иначе дефолт, переданный из i18n.
export function safetyDocText(s: SettingsLike, lang: SafetyLang, fallback: string): string {
  const doc = readSafetyDoc(s)
  if (!doc) return fallback
  const text = lang === 'en' ? doc.text_en : lang === 'es' ? doc.text_es : doc.text_ru
  return text && text.trim() ? text : fallback
}

// Подпись «актуальна», если версия совпадает с текущей И подписана не позже TTL (по умолчанию 7 дней).
export function isAckCurrent(
  ack: { doc_version?: string | null; signed_at?: string | null } | null | undefined,
  version: string,
  nowMs: number,
  ttlDays: number = SAFETY_ACK_TTL_DAYS,
): boolean {
  if (!ack || !ack.signed_at) return false
  if ((ack.doc_version ?? 'v1') !== version) return false
  const signed = new Date(ack.signed_at).getTime()
  if (Number.isNaN(signed)) return false
  return nowMs - signed <= ttlDays * DAY_MS
}

// Следующая версия свода: без изменений текста — прежняя; иначе vN → v(N+1) (нестандартную → 'v2').
export function nextSafetyVersion(currentVersion: string | null, changed: boolean): string {
  if (!changed) return currentVersion ?? 'v1'
  const base = currentVersion ?? 'v1'
  const m = /^v(\d+)$/.exec(base)
  return m ? `v${Number(m[1]) + 1}` : 'v2'
}
