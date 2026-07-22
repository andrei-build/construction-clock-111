// TRIM-OPENINGS-21: библиотека трим-пресетов для проёмов (окна/двери) + чистый расчёт линейных футов.
// Отдельный модуль данных по образцу sketchFinishes.ts (TILE_SIZE_OPTIONS) / sketchCatalog.ts:
// экспорт данных + типов, БЕЗ побочных зависимостей (лист-модуль как ./inches) — чтобы не было циклов
// (sketchFinishes импортирует отсюда типы/санитайзер, а не наоборот).

export type OpeningKind = 'door' | 'window'
export type TrimApplicability = OpeningKind | 'both'
// «вид» трима для отдельной строки материала: casing / header / подоконник.
export type TrimProfileKind = 'casing' | 'header' | 'stool'
export type OpeningTrimSideKey = 'top' | 'left' | 'right' | 'bottom'

export type TrimLabels = { ru: string; en: string; es: string }

// Профиль = что покупаем (обсада 2.5", карниз 5" «корона», подоконник stool+apron).
export type TrimProfile = {
  id: string
  kind: TrimProfileKind
  labels: TrimLabels
  widthIn: number
  applies: TrimApplicability
  color: string // цвет обводки на развёртке (НЕ интерфейсный --accent)
}

// Пресет = какой профиль назначается каждой стороне по умолчанию.
export type TrimPreset = {
  id: string
  labels: TrimLabels
  applies: TrimApplicability
  isDefault?: boolean
  sides: Partial<Record<OpeningTrimSideKey, string>> // сторона -> profile id
}

// Хранится на проёме (Opening.trim), ОПЦИОНАЛЬНО и аддитивно (version:1 не трогаем):
// presetId — выбранный пресет; sides — переопределения по сторонам (другой профиль / выключено).
export type OpeningTrimSide = { profileId: string; enabled: boolean }
export type OpeningTrim = {
  presetId?: string
  sides?: Partial<Record<OpeningTrimSideKey, OpeningTrimSide>>
}

export type ResolvedTrimSide = {
  side: OpeningTrimSideKey
  profileId: string
  enabled: boolean
}

export const TRIM_SIDE_ORDER: OpeningTrimSideKey[] = ['top', 'left', 'right', 'bottom']
export const DEFAULT_TRIM_WASTE_PCT = 10

export const TRIM_PROFILES: TrimProfile[] = [
  {
    id: 'casing-2_5',
    kind: 'casing',
    labels: { ru: 'Обсада 2.5"', en: 'Casing 2.5"', es: 'Marco 2.5"' },
    widthIn: 2.5,
    applies: 'both',
    color: '#b45309',
  },
  {
    id: 'header-5',
    kind: 'header',
    labels: { ru: 'Карниз 5" (корона)', en: 'Header 5" (crown)', es: 'Cornisa 5" (corona)' },
    widthIn: 5,
    applies: 'both',
    color: '#0e7490',
  },
  {
    id: 'stool-apron',
    kind: 'stool',
    labels: { ru: 'Подоконник (stool+apron)', en: 'Stool + apron', es: 'Alféizar (stool+apron)' },
    widthIn: 5.25,
    applies: 'window',
    color: '#4d7c0f',
  },
]

export const TRIM_PRESETS: TrimPreset[] = [
  {
    id: 'window-casing',
    labels: { ru: 'Обсада + карниз', en: 'Casing + header', es: 'Marco + cornisa' },
    applies: 'window',
    isDefault: true,
    sides: { top: 'header-5', left: 'casing-2_5', right: 'casing-2_5', bottom: 'casing-2_5' },
  },
  {
    id: 'window-stool',
    labels: { ru: 'С подоконником', en: 'With stool', es: 'Con alféizar' },
    applies: 'window',
    sides: { top: 'header-5', left: 'casing-2_5', right: 'casing-2_5', bottom: 'stool-apron' },
  },
  {
    id: 'door-casing',
    labels: { ru: 'Обсада + карниз', en: 'Casing + header', es: 'Marco + cornisa' },
    applies: 'door',
    isDefault: true,
    sides: { top: 'header-5', left: 'casing-2_5', right: 'casing-2_5' },
  },
]

const PROFILE_BY_ID = new Map(TRIM_PROFILES.map((profile) => [profile.id, profile]))
const PRESET_BY_ID = new Map(TRIM_PRESETS.map((preset) => [preset.id, preset]))
const PROFILE_ORDER = new Map(TRIM_PROFILES.map((profile, index) => [profile.id, index]))

export function trimLabel(labels: TrimLabels, lang: 'ru' | 'en' | 'es' = 'en'): string {
  return labels[lang] ?? labels.en
}

export function trimProfileById(id: string | undefined): TrimProfile | undefined {
  return id ? PROFILE_BY_ID.get(id) : undefined
}

export function trimPresetById(id: string | undefined): TrimPreset | undefined {
  return id ? PRESET_BY_ID.get(id) : undefined
}

function appliesTo(applies: TrimApplicability, kind: OpeningKind): boolean {
  return applies === 'both' || applies === kind
}

export function trimProfilesForKind(kind: OpeningKind): TrimProfile[] {
  return TRIM_PROFILES.filter((profile) => appliesTo(profile.applies, kind))
}

export function trimPresetsForKind(kind: OpeningKind): TrimPreset[] {
  return TRIM_PRESETS.filter((preset) => appliesTo(preset.applies, kind))
}

export function defaultTrimPreset(kind: OpeningKind): TrimPreset {
  return (
    TRIM_PRESETS.find((preset) => preset.isDefault && appliesTo(preset.applies, kind))
    ?? trimPresetsForKind(kind)[0]
    ?? TRIM_PRESETS[0]
  )
}

export function activeTrimPresetId(kind: OpeningKind, trim?: OpeningTrim): string {
  const preset = trimPresetById(trim?.presetId)
  if (preset && appliesTo(preset.applies, kind)) return preset.id
  return defaultTrimPreset(kind).id
}

// Разворачивает трим проёма в полный список сторон с назначенным профилем.
// Пустой trim (старый эскиз / новый проём) → дефолт-пресет: «тыкаешь — и оно сразу выбирает».
export function resolveOpeningTrim(kind: OpeningKind, trim?: OpeningTrim): ResolvedTrimSide[] {
  const preset = trimPresetById(trim?.presetId) && appliesTo(trimPresetById(trim?.presetId)!.applies, kind)
    ? trimPresetById(trim?.presetId)!
    : defaultTrimPreset(kind)
  const sides = new Set<OpeningTrimSideKey>()
  TRIM_SIDE_ORDER.forEach((side) => {
    if (preset.sides[side]) sides.add(side)
  })
  if (trim?.sides) {
    (Object.keys(trim.sides) as OpeningTrimSideKey[]).forEach((side) => {
      if (TRIM_SIDE_ORDER.includes(side)) sides.add(side)
    })
  }
  return TRIM_SIDE_ORDER.filter((side) => sides.has(side)).map((side): ResolvedTrimSide => {
    const override = trim?.sides?.[side]
    if (override && trimProfileById(override.profileId)) {
      return { side, profileId: override.profileId, enabled: override.enabled }
    }
    const presetProfile = preset.sides[side]
    // default preset applied a profile here; override (if any) had an unknown profile → keep preset
    return { side, profileId: presetProfile ?? '', enabled: presetProfile ? (override?.enabled ?? true) : false }
  }).filter((entry) => !!entry.profileId)
}

export function trimSideLengthFt(side: OpeningTrimSideKey, widthFt: number, heightFt: number): number {
  const width = Number.isFinite(widthFt) && widthFt > 0 ? widthFt : 0
  const height = Number.isFinite(heightFt) && heightFt > 0 ? heightFt : 0
  return side === 'top' || side === 'bottom' ? width : height
}

export type TrimLinearInput = {
  kind: OpeningKind
  trim?: OpeningTrim
  widthFt: number
  heightFt: number
}

export type TrimMaterialSummaryRow = {
  profileId: string
  kind: TrimProfileKind
  labels: TrimLabels
  widthIn: number
  rawLnft: number // без запаса
  lnft: number // с запасом
}

export function clampTrimWastePct(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_TRIM_WASTE_PCT
  return Math.max(0, Math.min(100, n))
}

// Чистая функция расчёта: суммирует линейные футы ПО ВИДАМ трима (по профилю) со всех проёмов,
// добавляет запас %. Юнит-тестируется без supabase/DOM.
export function summarizeTrimMaterials(inputs: TrimLinearInput[], wastePct: number): TrimMaterialSummaryRow[] {
  const waste = clampTrimWastePct(wastePct)
  const factor = 1 + waste / 100
  const totals = new Map<string, number>()
  inputs.forEach((input) => {
    resolveOpeningTrim(input.kind, input.trim).forEach((side) => {
      if (!side.enabled) return
      const profile = trimProfileById(side.profileId)
      if (!profile) return
      const length = trimSideLengthFt(side.side, input.widthFt, input.heightFt)
      if (length <= 0) return
      totals.set(side.profileId, (totals.get(side.profileId) ?? 0) + length)
    })
  })
  return Array.from(totals.entries())
    .map(([profileId, rawLnft]): TrimMaterialSummaryRow | null => {
      const profile = trimProfileById(profileId)
      if (!profile || rawLnft <= 0) return null
      return {
        profileId,
        kind: profile.kind,
        labels: profile.labels,
        widthIn: profile.widthIn,
        rawLnft,
        lnft: rawLnft * factor,
      }
    })
    .filter((row): row is TrimMaterialSummaryRow => !!row)
    .sort((a, b) => (PROFILE_ORDER.get(a.profileId) ?? 0) - (PROFILE_ORDER.get(b.profileId) ?? 0))
}

function sanitizeTrimSide(value: unknown): OpeningTrimSide | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Partial<OpeningTrimSide>
  if (typeof raw.profileId !== 'string' || !PROFILE_BY_ID.has(raw.profileId)) return undefined
  return { profileId: raw.profileId, enabled: raw.enabled !== false }
}

// Санитайзер поля trim для sanitizeSketchOpenings / normalizeOpeningForModel:
// отбрасывает неизвестные пресеты/профили/стороны, чтобы битый JSON не срезал загрузку.
export function sanitizeOpeningTrim(value: unknown): OpeningTrim | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as { presetId?: unknown; sides?: unknown }
  const trim: OpeningTrim = {}
  if (typeof raw.presetId === 'string' && PRESET_BY_ID.has(raw.presetId)) trim.presetId = raw.presetId
  if (raw.sides && typeof raw.sides === 'object' && !Array.isArray(raw.sides)) {
    const sides: Partial<Record<OpeningTrimSideKey, OpeningTrimSide>> = {}
    ;(Object.entries(raw.sides as Record<string, unknown>)).forEach(([key, sideValue]) => {
      if (!TRIM_SIDE_ORDER.includes(key as OpeningTrimSideKey)) return
      const side = sanitizeTrimSide(sideValue)
      if (side) sides[key as OpeningTrimSideKey] = side
    })
    if (Object.keys(sides).length > 0) trim.sides = sides
  }
  return trim.presetId || trim.sides ? trim : undefined
}
