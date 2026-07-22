// AI-LAYOUT-30: детерминированный решатель раскладки кухни по нормам (NKBA/NEC/IRC) + расширяемый
// реестр правил «Проверки кода». Модуль ЧИСТЫЙ (без React/DOM) — только данные + функции, чтобы
// покрывать юнит-тестами (правила, детерминизм). Раскладка ВЫВОДИТСЯ в существующей модели ряда:
// солвер строит СТРОКУ КОДОВ кабинетов/техники, которую применяет тот же layoutCabinetRunOnWall
// (#22-#28) — новых персист-полей НЕ вводит. Числа-нормы заложены явными константами; полная база
// правил (claude/ai_layout_kitchen.md) добавляется в KITCHEN_LAYOUT_RULES без переписывания солвера.
//
// Якорная последовательность: мойка по центру окна/водоподвода → ПММ у мойки (≤36", ≥21" от угла) →
// плита с площадками 12"/15" и НЕ под окном → холодильник в конце ряда (15") → базы/ящики заполняют →
// филлеры 3" у стен/углов → навесные 18" над столешницей.
import { CABINET_MIN_FILLER_IN, DEFAULT_WALL_CABINET_GAP_IN } from './cabinetCodes'
import { formatInches, snapInchesToPrecision } from './inches'

// ── Нормы (дюймы) — единый источник чисел, на которые ссылаются правила и генератор ──────────────
export const CORNER_FILLER_IN = CABINET_MIN_FILLER_IN            // филлер 3" у стен/углов
export const DEFAULT_SINK_WIDTH_IN = 33
export const WIDE_SINK_WIDTH_IN = 36
export const DEFAULT_DISHWASHER_WIDTH_IN = 24
export const DEFAULT_RANGE_WIDTH_IN = 30
export const DEFAULT_REFRIGERATOR_WIDTH_IN = 33
export const DEFAULT_HOOD_WIDTH_IN = 30
export const RANGE_LANDING_SMALL_IN = 12                          // NKBA: 12" с одной стороны плиты
export const RANGE_LANDING_LARGE_IN = 15                          // NKBA: 15" с другой стороны плиты
export const REFRIGERATOR_LANDING_IN = 15                         // NKBA: 15" со стороны открывания
export const DISHWASHER_MAX_FROM_SINK_IN = 36                     // NKBA: ПММ ≤36" от мойки
export const DISHWASHER_MIN_FROM_CORNER_IN = 21                   // NKBA: ПММ ≥21" от угла
export const SINK_CENTER_TOLERANCE_IN = 3                         // мойка «по центру» окна с допуском
export const WALL_CABINET_ABOVE_COUNTER_IN = DEFAULT_WALL_CABINET_GAP_IN // навесные 18" над столешницей
export const REFRIGERATOR_END_TOLERANCE_IN = 6                    // «в конце ряда» — край у стены
export const RECEPTACLE_COUNTER_TRIGGER_IN = 24                   // NEC 210.52(C): столешница требует розетку

// Стандартные ширины для заполнения (дюймы), от большего к меньшему.
const BASE_FILL_WIDTHS_IN = [36, 33, 30, 27, 24, 21, 18, 15, 12] as const
const WALL_FILL_WIDTHS_IN = [36, 33, 30, 27, 24, 21, 18, 15, 12] as const
const MIN_CABINET_WIDTH_IN = 12
const EPS = 0.01

export type KitchenRole =
  | 'sink'
  | 'dishwasher'
  | 'range'
  | 'refrigerator'
  | 'hood'
  | 'base'
  | 'filler'
  | 'wall-cabinet'

export type KitchenLayer = 'base' | 'wall'

// Один размещённый элемент раскладки (совместим с моделью ряда: код+ширина+позиция вдоль стены).
export type KitchenSlot = {
  role: KitchenRole
  code: string
  widthIn: number
  startIn: number
  layer: KitchenLayer
}

// 1D-проекция стены (вход реестра правил): всё спроецировано на ось стены в дюймах.
export type KitchenElement1D = {
  id: string
  role: KitchenRole
  startIn: number
  endIn: number
  layer: KitchenLayer
}

export type KitchenOpening1D = { kind: 'window' | 'door' | 'opening'; startIn: number; endIn: number }

export type KitchenWallScene = {
  wallLengthIn: number
  base: KitchenElement1D[]
  wall: KitchenElement1D[]
  windows: KitchenOpening1D[]
  waterCentersIn: number[]
  outletsIn: number[]
}

// ── Реестр правил ───────────────────────────────────────────────────────────────────────────────
export type KitchenRuleSeverity = 'error' | 'warning' | 'info'

export type KitchenRuleIssue = {
  ruleId: string
  severity: KitchenRuleSeverity
  code: string          // ссылка на норму (NKBA/NEC/IRC)
  messageKey: string    // ключ i18n сообщения
  params: Record<string, string>
  elementId?: string    // id элемента-нарушителя (подсветка в UI)
  actualIn?: number
  requiredIn?: number
  centerIn?: number     // якорь вдоль стены для оверлея
  targetIn?: number
}

export type KitchenRule = {
  id: string
  severity: KitchenRuleSeverity
  code: string
  check: (scene: KitchenWallScene) => KitchenRuleIssue[]
}

function round(value: number): number {
  return snapInchesToPrecision(value)
}

function fmtIn(valueIn: number): string {
  return formatInches(round(valueIn))
}

function centerOf(el: KitchenElement1D): number {
  return (el.startIn + el.endIn) / 2
}

function widthOf(el: KitchenElement1D): number {
  return el.endIn - el.startIn
}

function nearest(values: number[], target: number): number | null {
  if (values.length === 0) return null
  return values.reduce((best, v) => (Math.abs(v - target) < Math.abs(best - target) ? v : best), values[0])
}

function edgeGap(a: KitchenElement1D, b: KitchenElement1D): number {
  if (a.endIn <= b.startIn) return b.startIn - a.endIn
  if (b.endIn <= a.startIn) return a.startIn - b.endIn
  return 0 // перекрываются
}

function intervalsOverlap(a: KitchenOpening1D, startIn: number, endIn: number): number {
  return Math.max(0, Math.min(a.endIn, endIn) - Math.max(a.startIn, startIn))
}

// Непрерывная столешница (базовые/мойка) вплотную к элементу с указанной стороны — «площадка».
function landingOnSide(scene: KitchenWallScene, subject: KitchenElement1D, side: 'left' | 'right'): number {
  const counters = scene.base
    .filter((el) => el.role === 'base' || el.role === 'sink')
    .sort((a, b) => a.startIn - b.startIn)
  let landing = 0
  if (side === 'left') {
    let edge = subject.startIn
    for (let i = counters.length - 1; i >= 0; i -= 1) {
      const el = counters[i]
      if (Math.abs(el.endIn - edge) <= EPS) {
        landing += widthOf(el)
        edge = el.startIn
      }
    }
  } else {
    let edge = subject.endIn
    for (let i = 0; i < counters.length; i += 1) {
      const el = counters[i]
      if (Math.abs(el.startIn - edge) <= EPS) {
        landing += widthOf(el)
        edge = el.endIn
      }
    }
  }
  return round(landing)
}

const ruleSinkWindowCenter: KitchenRule = {
  id: 'sink-window-center',
  severity: 'warning',
  code: 'NKBA',
  check: (scene) => {
    const anchors = scene.windows.length > 0
      ? scene.windows.map((w) => (w.startIn + w.endIn) / 2)
      : scene.waterCentersIn
    if (anchors.length === 0) return []
    return scene.base
      .filter((el) => el.role === 'sink')
      .flatMap((sink) => {
        const center = centerOf(sink)
        const anchor = nearest(anchors, center)
        if (anchor === null) return []
        const off = round(Math.abs(center - anchor))
        if (off <= SINK_CENTER_TOLERANCE_IN) return []
        return [{
          ruleId: 'sink-window-center',
          severity: 'warning' as const,
          code: 'NKBA',
          messageKey: 'kitchen_rule_sink_center',
          params: { actual: fmtIn(off) },
          elementId: sink.id,
          actualIn: off,
          requiredIn: 0,
          centerIn: center,
          targetIn: anchor,
        }]
      })
  },
}

const ruleDishwasherNearSink: KitchenRule = {
  id: 'dishwasher-near-sink',
  severity: 'warning',
  code: 'NKBA',
  check: (scene) => {
    const sinks = scene.base.filter((el) => el.role === 'sink')
    if (sinks.length === 0) return []
    return scene.base
      .filter((el) => el.role === 'dishwasher')
      .flatMap((dw) => {
        const gap = round(Math.min(...sinks.map((sink) => edgeGap(dw, sink))))
        if (gap <= DISHWASHER_MAX_FROM_SINK_IN) return []
        return [{
          ruleId: 'dishwasher-near-sink',
          severity: 'warning' as const,
          code: 'NKBA',
          messageKey: 'kitchen_rule_dw_sink',
          params: { actual: fmtIn(gap), required: fmtIn(DISHWASHER_MAX_FROM_SINK_IN) },
          elementId: dw.id,
          actualIn: gap,
          requiredIn: DISHWASHER_MAX_FROM_SINK_IN,
          centerIn: centerOf(dw),
        }]
      })
  },
}

const ruleDishwasherCorner: KitchenRule = {
  id: 'dishwasher-corner',
  severity: 'warning',
  code: 'NKBA',
  check: (scene) => scene.base
    .filter((el) => el.role === 'dishwasher')
    .flatMap((dw) => {
      const cornerDist = round(Math.min(dw.startIn, scene.wallLengthIn - dw.endIn))
      if (cornerDist >= DISHWASHER_MIN_FROM_CORNER_IN) return []
      return [{
        ruleId: 'dishwasher-corner',
        severity: 'warning' as const,
        code: 'NKBA',
        messageKey: 'kitchen_rule_dw_corner',
        params: { actual: fmtIn(cornerDist), required: fmtIn(DISHWASHER_MIN_FROM_CORNER_IN) },
        elementId: dw.id,
        actualIn: cornerDist,
        requiredIn: DISHWASHER_MIN_FROM_CORNER_IN,
        centerIn: centerOf(dw),
      }]
    }),
}

const ruleRangeLanding: KitchenRule = {
  id: 'range-landing',
  severity: 'warning',
  code: 'NKBA',
  check: (scene) => scene.base
    .filter((el) => el.role === 'range')
    .flatMap((range) => {
      const left = landingOnSide(scene, range, 'left')
      const right = landingOnSide(scene, range, 'right')
      const small = Math.min(left, right)
      const large = Math.max(left, right)
      if (small + EPS >= RANGE_LANDING_SMALL_IN && large + EPS >= RANGE_LANDING_LARGE_IN) return []
      return [{
        ruleId: 'range-landing',
        severity: 'warning' as const,
        code: 'NKBA',
        messageKey: 'kitchen_rule_range_landing',
        params: {
          actual: fmtIn(small),
          required: fmtIn(RANGE_LANDING_SMALL_IN),
          large: fmtIn(RANGE_LANDING_LARGE_IN),
        },
        elementId: range.id,
        actualIn: small,
        requiredIn: RANGE_LANDING_SMALL_IN,
        centerIn: centerOf(range),
      }]
    }),
}

const ruleRangeUnderWindow: KitchenRule = {
  id: 'range-under-window',
  severity: 'error',
  code: 'IRC',
  check: (scene) => scene.base
    .filter((el) => el.role === 'range')
    .flatMap((range) => {
      const overlaps = scene.windows.some((w) => intervalsOverlap(w, range.startIn, range.endIn) > EPS)
      if (!overlaps) return []
      return [{
        ruleId: 'range-under-window',
        severity: 'error' as const,
        code: 'IRC',
        messageKey: 'kitchen_rule_range_window',
        params: {},
        elementId: range.id,
        centerIn: centerOf(range),
      }]
    }),
}

const ruleCountertopReceptacle: KitchenRule = {
  id: 'nec-countertop-receptacle',
  severity: 'error',
  code: 'NEC 210.52(C)',
  check: (scene) => {
    const counterWidth = round(scene.base
      .filter((el) => el.role === 'base' || el.role === 'sink')
      .reduce((sum, el) => sum + widthOf(el), 0))
    if (counterWidth < RECEPTACLE_COUNTER_TRIGGER_IN) return []
    if (scene.outletsIn.length > 0) return []
    return [{
      ruleId: 'nec-countertop-receptacle',
      severity: 'error' as const,
      code: 'NEC 210.52(C)',
      messageKey: 'kitchen_rule_receptacle',
      params: { required: fmtIn(RECEPTACLE_COUNTER_TRIGGER_IN) },
      requiredIn: RECEPTACLE_COUNTER_TRIGGER_IN,
    }]
  },
}

const ruleRefrigeratorEnd: KitchenRule = {
  id: 'refrigerator-end',
  severity: 'info',
  code: 'NKBA',
  check: (scene) => scene.base
    .filter((el) => el.role === 'refrigerator')
    .flatMap((fridge) => {
      const endDist = round(Math.min(fridge.startIn, scene.wallLengthIn - fridge.endIn))
      if (endDist <= REFRIGERATOR_END_TOLERANCE_IN) return []
      return [{
        ruleId: 'refrigerator-end',
        severity: 'info' as const,
        code: 'NKBA',
        messageKey: 'kitchen_rule_fridge_end',
        params: { actual: fmtIn(endDist) },
        elementId: fridge.id,
        actualIn: endDist,
        centerIn: centerOf(fridge),
      }]
    }),
}

const ruleRefrigeratorLanding: KitchenRule = {
  id: 'refrigerator-landing',
  severity: 'warning',
  code: 'NKBA',
  check: (scene) => scene.base
    .filter((el) => el.role === 'refrigerator')
    .flatMap((fridge) => {
      // сторона открывания = сторона от угла (внутрь ряда)
      const towardEnd = fridge.startIn <= scene.wallLengthIn - fridge.endIn ? 'right' : 'left'
      const landing = landingOnSide(scene, fridge, towardEnd)
      if (landing + EPS >= REFRIGERATOR_LANDING_IN) return []
      return [{
        ruleId: 'refrigerator-landing',
        severity: 'warning' as const,
        code: 'NKBA',
        messageKey: 'kitchen_rule_fridge_landing',
        params: { actual: fmtIn(landing), required: fmtIn(REFRIGERATOR_LANDING_IN) },
        elementId: fridge.id,
        actualIn: landing,
        requiredIn: REFRIGERATOR_LANDING_IN,
        centerIn: centerOf(fridge),
      }]
    }),
}

// Расширяемый реестр: KEY-правила из спеки заложены с числами; остальные NKBA/NEC/IRC
// (claude/ai_layout_kitchen.md) добавляются сюда новыми записями без переписывания солвера.
// TODO-hook: extend with more rules (electrical GFCI, work-triangle, aisle clearance, hood height…).
export const KITCHEN_LAYOUT_RULES: KitchenRule[] = [
  ruleSinkWindowCenter,
  ruleDishwasherNearSink,
  ruleDishwasherCorner,
  ruleRangeLanding,
  ruleRangeUnderWindow,
  ruleCountertopReceptacle,
  ruleRefrigeratorEnd,
  ruleRefrigeratorLanding,
]

export function checkKitchenWall(scene: KitchenWallScene): KitchenRuleIssue[] {
  return KITCHEN_LAYOUT_RULES.flatMap((rule) => rule.check(scene))
}

// ── Генератор раскладки ───────────────────────────────────────────────────────────────────────
export type KitchenApplianceRequest = {
  dishwasher?: boolean
  range?: boolean
  refrigerator?: boolean
  hood?: boolean
  sinkWidthIn?: number
}

export type KitchenLayoutInput = {
  wallLengthIn: number
  anchorIn?: number
  windows?: KitchenOpening1D[]
  waterCentersIn?: number[]
  outletsIn?: number[]
  appliances?: KitchenApplianceRequest
}

export type KitchenLayoutMetrics = {
  wallLengthIn: number
  anchorIn: number
  sinkCenterIn: number
  dwToSinkIn: number | null
  dwToCornerIn: number | null
  rangeLeftLandingIn: number | null
  rangeRightLandingIn: number | null
  rangeUnderWindow: boolean
  fridgeAtEnd: boolean
  fridgeLandingIn: number | null
  cornerFillerIn: number
  wallGapIn: number
}

export type KitchenLayoutVariant = {
  id: string
  index: number
  titleKey: string
  baseSlots: KitchenSlot[]
  wallSlots: KitchenSlot[]
  slots: KitchenSlot[]
  baseCode: string
  wallCode: string
  code: string
  scene: KitchenWallScene
  issues: KitchenRuleIssue[]
  metrics: KitchenLayoutMetrics
}

const VARIANT_TITLE_KEYS = ['kitchen_variant_a', 'kitchen_variant_b', 'kitchen_variant_c'] as const

type Part =
  | { kind: 'fixed'; role: KitchenRole; widthIn: number; code: string }
  | { kind: 'fill'; widthIn: number }

function fillerCode(prefix: 'BF', widthIn: number): string {
  return `${prefix}${formatInches(round(widthIn)).replace(/"/g, '').replace(/\s+/g, '-')}`
}

function pad2(value: number): string {
  return String(Math.round(value)).padStart(2, '0')
}

// Разворачивает {kind:'fill', width} в базовые шкафы стандартных ширин; остаток поглощает ПОСЛЕДНИЙ
// шкаф (без мид-филлеров — филлер только у угла/стены). Даёт непрерывную столешницу-«площадку».
function expandBaseFill(widthIn: number): Array<{ role: KitchenRole; widthIn: number; code: string }> {
  const out: Array<{ role: KitchenRole; widthIn: number; code: string }> = []
  let remaining = round(widthIn)
  if (remaining <= EPS) return out
  // оставляем не менее одного шкафа под остаток (≥ MIN), чтобы последний вобрал «хвост».
  while (remaining >= 2 * MIN_CABINET_WIDTH_IN - EPS) {
    const cap = remaining - MIN_CABINET_WIDTH_IN
    const w = BASE_FILL_WIDTHS_IN.find((candidate) => candidate <= cap + EPS) ?? MIN_CABINET_WIDTH_IN
    out.push({ role: 'base', widthIn: w, code: `B${w}` })
    remaining = round(remaining - w)
  }
  out.push({ role: 'base', widthIn: remaining, code: `B${remaining}` })
  return out
}

// Раскладывает список частей контигуозно от startIn, назначая каждому slot стартовую координату.
function layoutParts(parts: Part[], startIn: number, layer: KitchenLayer): KitchenSlot[] {
  const slots: KitchenSlot[] = []
  let cursor = startIn
  parts.forEach((part) => {
    const pieces = part.kind === 'fixed'
      ? [{ role: part.role, widthIn: part.widthIn, code: part.code }]
      : expandBaseFill(part.widthIn)
    pieces.forEach((piece) => {
      slots.push({ role: piece.role, code: piece.code, widthIn: round(piece.widthIn), startIn: round(cursor), layer })
      cursor = round(cursor + piece.widthIn)
    })
  })
  return slots
}

// Навесной ряд: плитка W-шкафами до окна (или всей стены) с ВЫТЯЖКОЙ над плитой. Без филлеров
// навесного слоя (код 'F' парсится как базовый) — остаток поглощается последним W-шкафом.
function tileWall(fromIn: number, toIn: number): KitchenSlot[] {
  const slots: KitchenSlot[] = []
  let cursor = round(fromIn)
  let remaining = round(toIn - fromIn)
  const widths: number[] = []
  while (remaining >= MIN_CABINET_WIDTH_IN - EPS) {
    const w = WALL_FILL_WIDTHS_IN.find((candidate) => candidate <= remaining + EPS) ?? MIN_CABINET_WIDTH_IN
    widths.push(w)
    remaining = round(remaining - w)
  }
  if (widths.length === 0) {
    if (remaining > EPS) widths.push(remaining)
  } else if (remaining > EPS) {
    widths[widths.length - 1] = round(widths[widths.length - 1] + remaining)
  }
  widths.forEach((w) => {
    slots.push({ role: 'wall-cabinet', code: `W${pad2(w)}30`, widthIn: round(w), startIn: cursor, layer: 'wall' })
    cursor = round(cursor + w)
  })
  return slots
}

function buildWallSlots(
  hasHood: boolean,
  rangeStartIn: number | null,
  rangeWidthIn: number,
  uppersEndIn: number,
): KitchenSlot[] {
  if (uppersEndIn <= EPS) return []
  if (!hasHood || rangeStartIn === null || rangeStartIn >= uppersEndIn - EPS) {
    return tileWall(0, uppersEndIn)
  }
  const hoodStart = round(rangeStartIn)
  const hoodEnd = round(Math.min(uppersEndIn, rangeStartIn + rangeWidthIn))
  const left = tileWall(0, hoodStart)
  const hood: KitchenSlot = {
    role: 'hood',
    code: `HOOD${Math.round(rangeWidthIn)}`,
    widthIn: round(hoodEnd - hoodStart),
    startIn: hoodStart,
    layer: 'wall',
  }
  const right = tileWall(hoodEnd, uppersEndIn)
  return [...left, hood, ...right]
}

function sceneFromSlots(
  baseSlots: KitchenSlot[],
  wallSlots: KitchenSlot[],
  input: KitchenLayoutInput,
): KitchenWallScene {
  const toEl = (slot: KitchenSlot, index: number): KitchenElement1D => ({
    id: `${slot.layer}-${index}-${slot.code}`,
    role: slot.role,
    startIn: slot.startIn,
    endIn: round(slot.startIn + slot.widthIn),
    layer: slot.layer,
  })
  return {
    wallLengthIn: round(input.wallLengthIn),
    base: baseSlots.map(toEl),
    wall: wallSlots.map(toEl),
    windows: input.windows ?? [],
    waterCentersIn: input.waterCentersIn ?? [],
    outletsIn: input.outletsIn ?? [],
  }
}

function resolveAnchor(input: KitchenLayoutInput): number {
  if (typeof input.anchorIn === 'number' && Number.isFinite(input.anchorIn)) return input.anchorIn
  if (input.windows && input.windows.length > 0) {
    const w = input.windows[0]
    return (w.startIn + w.endIn) / 2
  }
  if (input.waterCentersIn && input.waterCentersIn.length > 0) return input.waterCentersIn[0]
  return input.wallLengthIn / 2
}

function buildVariant(input: KitchenLayoutInput, index: number): KitchenLayoutVariant {
  const L = round(input.wallLengthIn)
  const req = input.appliances ?? {}
  const wantDw = req.dishwasher !== false
  const wantRange = req.range !== false
  const wantFridge = req.refrigerator !== false
  const wantHood = req.hood !== false && wantRange
  const sinkW = round(index === 1 ? WIDE_SINK_WIDTH_IN : (req.sinkWidthIn && req.sinkWidthIn > 0 ? req.sinkWidthIn : DEFAULT_SINK_WIDTH_IN))
  const rangeCode = index === 2 ? 'COOK' : 'RANGE'
  const rangeW = DEFAULT_RANGE_WIDTH_IN
  // ПММ вплотную к мойке (справа), плита слева с площадками, холодильник — в конце ряда справа.
  // Варианты различаются шириной мойки (v1) и типом варочной поверхности (v2).
  const anchor = resolveAnchor(input)
  const sinkStart = round(Math.max(0, Math.min(L - sinkW, anchor - sinkW / 2)))
  const sinkEnd = round(sinkStart + sinkW)
  const leftSpan = round(sinkStart)
  const rightSpan = round(L - sinkEnd)

  // ── Левая зона [0, sinkStart]: угловой филлер, плита с площадками, (ПММ если слева) ──
  const leftParts: Part[] = []
  const corner = Math.min(CORNER_FILLER_IN, leftSpan)
  if (corner > EPS) leftParts.push({ kind: 'fixed', role: 'filler', widthIn: corner, code: fillerCode('BF', corner) })
  let leftUsed = corner
  const rangeReserve = wantRange ? rangeW : 0
  const freeLanding = round(leftSpan - leftUsed - rangeReserve)
  let rangeStartIn: number | null = null
  if (wantRange && freeLanding >= 0) {
    let landingCorner: number
    let landingSink: number
    if (freeLanding + EPS >= RANGE_LANDING_SMALL_IN + RANGE_LANDING_LARGE_IN) {
      landingCorner = RANGE_LANDING_SMALL_IN
      landingSink = round(freeLanding - RANGE_LANDING_SMALL_IN)
    } else {
      landingCorner = 0
      landingSink = freeLanding
    }
    if (landingCorner > EPS) leftParts.push({ kind: 'fill', widthIn: landingCorner })
    rangeStartIn = round(leftUsed + landingCorner)
    leftParts.push({ kind: 'fixed', role: 'range', widthIn: rangeW, code: `${rangeCode}${rangeW}` })
    if (landingSink > EPS) leftParts.push({ kind: 'fill', widthIn: landingSink })
    leftUsed = round(leftUsed + landingCorner + rangeW + landingSink)
  } else {
    // Плита не помещается слева — заполняем базовыми.
    const fill = round(leftSpan - leftUsed)
    if (fill > EPS) leftParts.push({ kind: 'fill', widthIn: fill })
    leftUsed = leftSpan
  }
  const leftTail = round(leftSpan - leftUsed)
  if (leftTail > EPS) leftParts.push({ kind: 'fill', widthIn: leftTail })

  // ── Мойка ──
  const sinkParts: Part[] = [{ kind: 'fixed', role: 'sink', widthIn: sinkW, code: `SB${sinkW}` }]

  // ── Правая зона [sinkEnd, L]: (ПММ если справа), площадка холодильника, холодильник в конце ──
  const rightParts: Part[] = []
  let rightUsed = 0
  const dwRight = wantDw
  if (dwRight) {
    rightParts.push({ kind: 'fixed', role: 'dishwasher', widthIn: DEFAULT_DISHWASHER_WIDTH_IN, code: `DW${DEFAULT_DISHWASHER_WIDTH_IN}` })
    rightUsed = round(rightUsed + DEFAULT_DISHWASHER_WIDTH_IN)
  }
  if (wantFridge && round(rightSpan - rightUsed - DEFAULT_REFRIGERATOR_WIDTH_IN) >= 0) {
    const landing = round(rightSpan - rightUsed - DEFAULT_REFRIGERATOR_WIDTH_IN)
    if (landing > EPS) rightParts.push({ kind: 'fill', widthIn: landing })
    rightParts.push({ kind: 'fixed', role: 'refrigerator', widthIn: DEFAULT_REFRIGERATOR_WIDTH_IN, code: `REF${DEFAULT_REFRIGERATOR_WIDTH_IN}` })
    rightUsed = round(rightSpan)
  } else {
    const fill = round(rightSpan - rightUsed)
    if (fill > EPS) rightParts.push({ kind: 'fill', widthIn: fill })
    rightUsed = rightSpan
  }

  const baseSlots = [
    ...layoutParts(leftParts, 0, 'base'),
    ...layoutParts(sinkParts, sinkStart, 'base'),
    ...layoutParts(rightParts, sinkEnd, 'base'),
  ]

  // Навесной ряд до окна (не перекрывая проём); вытяжка над плитой.
  const windowStart = (input.windows && input.windows.length > 0)
    ? round(Math.min(...input.windows.map((w) => w.startIn)))
    : L
  const uppersEnd = round(Math.max(rangeStartIn !== null ? rangeStartIn + rangeW : 0, Math.min(L, windowStart)))
  const wallSlots = buildWallSlots(wantHood, rangeStartIn, rangeW, uppersEnd)

  const slots = [...baseSlots, ...wallSlots]
  const baseCode = baseSlots.map((s) => s.code).join(' ')
  const wallCode = wallSlots.map((s) => s.code).join(' ')
  const code = [baseCode, wallCode].filter(Boolean).join(' ')
  const scene = sceneFromSlots(baseSlots, wallSlots, input)

  const sinkEl = scene.base.find((el) => el.role === 'sink')
  const dwEl = scene.base.find((el) => el.role === 'dishwasher')
  const rangeEl = scene.base.find((el) => el.role === 'range')
  const fridgeEl = scene.base.find((el) => el.role === 'refrigerator')

  const metrics: KitchenLayoutMetrics = {
    wallLengthIn: L,
    anchorIn: round(anchor),
    sinkCenterIn: sinkEl ? round(centerOf(sinkEl)) : round(sinkStart + sinkW / 2),
    dwToSinkIn: dwEl && sinkEl ? round(edgeGap(dwEl, sinkEl)) : null,
    dwToCornerIn: dwEl ? round(Math.min(dwEl.startIn, L - dwEl.endIn)) : null,
    rangeLeftLandingIn: rangeEl ? landingOnSide(scene, rangeEl, 'left') : null,
    rangeRightLandingIn: rangeEl ? landingOnSide(scene, rangeEl, 'right') : null,
    rangeUnderWindow: rangeEl ? scene.windows.some((w) => intervalsOverlap(w, rangeEl.startIn, rangeEl.endIn) > EPS) : false,
    fridgeAtEnd: fridgeEl ? Math.min(fridgeEl.startIn, L - fridgeEl.endIn) <= REFRIGERATOR_END_TOLERANCE_IN + EPS : false,
    fridgeLandingIn: fridgeEl ? landingOnSide(scene, fridgeEl, fridgeEl.startIn <= L - fridgeEl.endIn ? 'right' : 'left') : null,
    cornerFillerIn: corner,
    wallGapIn: WALL_CABINET_ABOVE_COUNTER_IN,
  }

  // Само-проверка эргономики (без NEC-розеток — их солвер не размещает).
  const issues = checkKitchenWall(scene).filter((issue) => issue.ruleId !== 'nec-countertop-receptacle')

  return {
    id: `kitchen-variant-${index}`,
    index,
    titleKey: VARIANT_TITLE_KEYS[index] ?? VARIANT_TITLE_KEYS[0],
    baseSlots,
    wallSlots,
    slots,
    baseCode,
    wallCode,
    code,
    scene,
    issues,
    metrics,
  }
}

// Детерминированный вход → детерминированный выход (без Math.random; вариативность — по index).
export function solveKitchenLayout(input: KitchenLayoutInput, variantCount = 3): KitchenLayoutVariant[] {
  const count = Math.max(1, Math.min(3, variantCount))
  const variants: KitchenLayoutVariant[] = []
  for (let i = 0; i < count; i += 1) variants.push(buildVariant(input, i))
  return variants
}
