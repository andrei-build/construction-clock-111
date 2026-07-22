// CABINET-FRONTS-25: единый модуль отрисовки ФРОНТА шкафа (стиль SHAKER — рамка + плоская
// филёнка + bar-pull ручки + toe-kick у баз + стекло у витрин). Чистая функция от
// (код, ширинаIn, высотаIn, стиль) → раскладка дверей/ящиков (KCMA) → SVG-разметка.
//
// АРХИТЕКТУРА: computeCabinetFrontLayout — чистая, детерминированная функция (юнит-тестируется).
// Параметр `style` сейчас заглушка ('shaker'); при получении дилерских спек-буков сюда
// подключаются цвета/фактуры коллекций БЕЗ переписывания вызывающего кода (WallElevation/галерея).
// Модель/геометрия НЕ трогаются — фронт вычисляется из уже сохранённых кода/ширины/высоты.

import type { ReactNode } from 'react'
import { parseCabinetCode } from './cabinetCodes'

// Заглушка стиля/коллекции. Позже: 'shaker' | 'flat-slab' | '<dealer-collection-id>' + палитра.
export type CabinetFrontStyle = 'shaker'

export type CabinetFrontKind =
  | 'base'
  | 'drawerBase'
  | 'wall'
  | 'tall'
  | 'vanity'
  | 'filler'
  | 'panel'
  | 'appliance'

export type CabinetFrontApplianceKind = 'dishwasher' | 'range' | 'refrigerator' | 'hood' | 'wine'

export type CabinetFrontPanelType = 'door' | 'drawer' | 'glass' | 'blank'
export type CabinetFrontPullKind = 'none' | 'barV' | 'barH'
export type CabinetFrontPullAt = 'left' | 'right' | 'center'

// Один фасад-панель (дверь/ящик), координаты — доли [0..1] всего бокса фронта (origin top-left).
export type CabinetFrontPanel = {
  x: number
  y: number
  w: number
  h: number
  type: CabinetFrontPanelType
  pull: CabinetFrontPullKind
  pullAt: CabinetFrontPullAt
}

export type CabinetFrontLayout = {
  code: string
  style: CabinetFrontStyle
  kind: CabinetFrontKind
  widthIn: number
  heightIn: number
  toeKick: boolean
  toeKickFrac: number
  glass: boolean
  doors: number
  drawers: number
  appliance?: CabinetFrontApplianceKind
  panels: CabinetFrontPanel[]
}

const TOE_KICK_IN = 4
const DRAWER_BAND_IN = 6
const DEFAULT_BASE_HEIGHT_IN = 34.5
const DEFAULT_WALL_HEIGHT_IN = 30

// Реквизиты раскладки — доли всего бокса.
const EDGE = 0.05 // отступ фасадов от края корпуса (реквизит корпуса)
const GAP = 0.022 // зазор (reveal) между соседними фасадами

type Rect = { x: number; y: number; w: number; h: number }

function finitePos(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function splitCols(r: Rect, n: number, gap: number): Rect[] {
  if (n <= 1) return [r]
  const cw = (r.w - gap * (n - 1)) / n
  return Array.from({ length: n }, (_, i) => ({ x: r.x + i * (cw + gap), y: r.y, w: cw, h: r.h }))
}

function splitRows(r: Rect, weights: number[], gap: number): Rect[] {
  const n = weights.length
  if (n <= 1) return [r]
  const sum = weights.reduce((a, b) => a + b, 0)
  const avail = r.h - gap * (n - 1)
  const out: Rect[] = []
  let yy = r.y
  for (const wgt of weights) {
    const hh = avail * (wgt / sum)
    out.push({ x: r.x, y: yy, w: r.w, h: hh })
    yy += hh + gap
  }
  return out
}

// KCMA-раскладка дверей: узкие шкафы (≤21" база / ≤24" навесной) = 1 дверь, шире = 2 двери.
function baseDoorCount(widthIn: number): number {
  return widthIn > 21 ? 2 : 1
}
function wallDoorCount(widthIn: number): number {
  return widthIn > 24 ? 2 : 1
}

// Число ящиков у drawer-base по коду: 1DB/2DB/3DB → 1/2/3, generic DB → 3.
function drawerBankCount(prefix: string): number {
  if (prefix === '1DB') return 1
  if (prefix === '2DB') return 2
  if (prefix === '3DB') return 3
  return 3
}

function applianceKind(prefix: string): CabinetFrontApplianceKind | null {
  if (prefix === 'DW') return 'dishwasher'
  if (prefix === 'RANGE') return 'range'
  if (prefix === 'REF') return 'refrigerator'
  if (prefix === 'HOOD') return 'hood'
  if (prefix === 'WINE') return 'wine'
  return null
}

// Стеклянная витрина: код с суффиксом "GD"/"G" после размера (напр. W3030GD) — распознаётся
// без изменения модели (парсер игнорирует суффикс, но сырой код его хранит). Чистая функция кода.
function hasGlassSuffix(code: string): boolean {
  return /\dG(?:D)?$/.test(code.toUpperCase())
}

function doorPanels(rects: Rect[], glass: boolean): CabinetFrontPanel[] {
  const type: CabinetFrontPanelType = glass ? 'glass' : 'door'
  return rects.map((r, i) => ({
    ...r,
    type,
    pull: 'barV' as CabinetFrontPullKind,
    // 2 двери: ручки встречаются у центра (левая — справа, правая — слева); 1 дверь — справа.
    pullAt: rects.length === 2 ? (i === 0 ? 'right' : 'left') : ('right' as CabinetFrontPullAt),
  }))
}

// Чистая функция раскладки фронта. style — заглушка под будущие коллекции спек-буков.
export function computeCabinetFrontLayout(
  code: string,
  widthInRaw: number,
  heightInRaw: number,
  style: CabinetFrontStyle = 'shaker',
): CabinetFrontLayout {
  const parsed = parseCabinetCode(code)
  const prefix = parsed?.prefix ?? ''
  const layer = parsed?.layer ?? 'base'
  const widthIn = finitePos(widthInRaw) ?? finitePos(parsed?.widthIn) ?? 24
  const heightIn =
    finitePos(heightInRaw) ??
    finitePos(parsed?.heightIn) ??
    (layer === 'wall' ? DEFAULT_WALL_HEIGHT_IN : DEFAULT_BASE_HEIGHT_IN)

  const appliance = applianceKind(prefix)
  const isFiller = !!parsed?.filler || prefix === 'F' || prefix === 'BF'
  const isPanel = !!parsed?.panel || prefix === 'BEP' || prefix === 'REP'
  const isDrawerBase = prefix === '1DB' || prefix === '2DB' || prefix === '3DB' || prefix === 'DB'
  const isWall = layer === 'wall' && !appliance
  const isTall = prefix === 'U'
  const isVanity = prefix === 'V'

  let kind: CabinetFrontKind = 'base'
  if (appliance) kind = 'appliance'
  else if (isFiller) kind = 'filler'
  else if (isPanel) kind = 'panel'
  else if (isDrawerBase) kind = 'drawerBase'
  else if (isWall) kind = 'wall'
  else if (isTall) kind = 'tall'
  else if (isVanity) kind = 'vanity'

  const glass =
    hasGlassSuffix(parsed?.code ?? code) &&
    (kind === 'wall' || kind === 'tall' || kind === 'base' || kind === 'vanity')

  const toeKick = kind === 'base' || kind === 'drawerBase' || kind === 'tall' || kind === 'vanity'
  const toeKickFrac = toeKick ? Math.min(0.16, Math.max(0.06, TOE_KICK_IN / heightIn)) : 0

  const faceTop = EDGE
  const faceBottom = 1 - EDGE - toeKickFrac
  const faceLeft = EDGE
  const faceRight = 1 - EDGE
  const face: Rect = { x: faceLeft, y: faceTop, w: faceRight - faceLeft, h: faceBottom - faceTop }

  const panels: CabinetFrontPanel[] = []
  let doors = 0
  let drawers = 0

  if (kind === 'base' || kind === 'vanity') {
    // KCMA: верхний ящик на всю ширину + двери снизу (B30 = 2 двери + 1 ящик; узкая ≤21 = 1 дверь + 1 ящик).
    const drawerH = Math.min(0.24, Math.max(0.12, DRAWER_BAND_IN / heightIn))
    panels.push({ x: face.x, y: face.y, w: face.w, h: drawerH, type: 'drawer', pull: 'barH', pullAt: 'center' })
    drawers = 1
    const doorTop = face.y + drawerH + GAP
    const doorRow: Rect = { x: face.x, y: doorTop, w: face.w, h: face.y + face.h - doorTop }
    const n = baseDoorCount(widthIn)
    panels.push(...doorPanels(splitCols(doorRow, n, GAP), glass))
    doors = n
  } else if (kind === 'drawerBase') {
    // Стопка ящиков: верхний чуть меньше (реалистично), остальные равные.
    const n = drawerBankCount(prefix)
    const weights = Array.from({ length: n }, (_, i) => (i === 0 && n > 1 ? 0.8 : 1))
    for (const r of splitRows(face, weights, GAP)) {
      panels.push({ ...r, type: 'drawer', pull: 'barH', pullAt: 'center' })
    }
    drawers = n
  } else if (kind === 'wall') {
    // Навесной: только двери, БЕЗ ящиков/toe-kick.
    const n = wallDoorCount(widthIn)
    panels.push(...doorPanels(splitCols(face, n, GAP), glass))
    doors = n
  } else if (kind === 'tall') {
    // Высокий (pantry/oven): колонки × 2 ряда (over/under). Стекло — на верхнем ряду.
    const colCount = widthIn > 30 ? 2 : 1
    for (const col of splitCols(face, colCount, GAP)) {
      const [upper, lower] = splitRows(col, [0.42, 0.58], GAP)
      panels.push(...doorPanels([upper], glass))
      panels.push(...doorPanels([lower], false))
      doors += 2
    }
  } else if (kind === 'filler' || kind === 'panel') {
    panels.push({ x: face.x, y: EDGE, w: face.w, h: 1 - 2 * EDGE, type: 'blank', pull: 'none', pullAt: 'center' })
  } else if (kind === 'appliance') {
    panels.push({ x: EDGE, y: EDGE, w: 1 - 2 * EDGE, h: 1 - 2 * EDGE, type: 'blank', pull: 'none', pullAt: 'center' })
  }

  return {
    code,
    style,
    kind,
    widthIn,
    heightIn,
    toeKick,
    toeKickFrac,
    glass,
    doors,
    drawers,
    appliance: appliance ?? undefined,
    panels,
  }
}

// ————— Отрисовка —————
// Один компонент рисует фронт в заданный бокс (x,y,w,h) в единицах вызывающего SVG.
// variant='elevation' — поверх тонированного корпуса развёртки (обводочный стиль, единицы = футы);
// variant='gallery' — крашеный shaker в собственном svg галереи (единицы viewBox). Раскладка общая.

export type CabinetFrontVariant = 'elevation' | 'gallery'

type ClassMap = {
  front: string
  door: string
  recess: string
  pull: string
  glass: string
  toe: string
  counter: string
  hatch: string
  grain: string
  appliance: string
  applianceLine: string
  label: string
}

const ELEVATION_CLASSES: ClassMap = {
  front: 'hub-sketch-elevation-cabinet-front',
  door: 'hub-sketch-elevation-cabinet-door',
  recess: 'hub-sketch-elevation-cabinet-recess',
  pull: 'hub-sketch-elevation-cabinet-pull',
  glass: 'hub-sketch-elevation-cabinet-glass',
  toe: 'hub-sketch-elevation-cabinet-toe',
  counter: 'hub-sketch-elevation-cabinet-counter',
  hatch: 'hub-sketch-elevation-cabinet-fill-mark',
  grain: 'hub-sketch-elevation-cabinet-grain',
  appliance: 'hub-sketch-elevation-cabinet-appliance',
  applianceLine: 'hub-sketch-elevation-cabinet-appliance-line',
  label: 'hub-sketch-elevation-cabinet-label',
}

const GALLERY_CLASSES: ClassMap = {
  front: 'hub-sketch-cabinet-front-group',
  door: 'hub-sketch-cabinet-front-door',
  recess: 'hub-sketch-cabinet-front-recess',
  pull: 'hub-sketch-cabinet-front-pull',
  glass: 'hub-sketch-cabinet-front-glass',
  toe: 'hub-sketch-cabinet-front-toe',
  counter: 'hub-sketch-cabinet-front-counter',
  hatch: 'hub-sketch-cabinet-front-hatch',
  grain: 'hub-sketch-cabinet-front-grain',
  appliance: 'hub-sketch-cabinet-front-appliance',
  applianceLine: 'hub-sketch-cabinet-front-appliance-line',
  label: 'hub-sketch-cabinet-front-label',
}

function abs(panel: Rect, box: Rect): Rect {
  return { x: box.x + panel.x * box.w, y: box.y + panel.y * box.h, w: panel.w * box.w, h: panel.h * box.h }
}

function pullElement(a: Rect, pull: CabinetFrontPullKind, at: CabinetFrontPullAt, cls: string, key: string): ReactNode {
  const minDim = Math.min(a.w, a.h)
  if (pull === 'barV') {
    const thick = Math.max(minDim * 0.05, 0.0001)
    const len = a.h * 0.32
    const inset = Math.min(a.w * 0.16, thick * 3)
    const cx = at === 'left' ? a.x + inset : at === 'right' ? a.x + a.w - inset : a.x + a.w / 2
    const y = a.y + a.h * 0.14
    return <rect key={key} className={cls} x={cx - thick / 2} y={y} width={thick} height={len} rx={thick / 2} />
  }
  if (pull === 'barH') {
    const thick = Math.max(minDim * 0.06, 0.0001)
    const len = a.w * 0.42
    const cx = a.x + a.w / 2
    const y = a.y + a.h * 0.24
    return <rect key={key} className={cls} x={cx - len / 2} y={y - thick / 2} width={len} height={thick} rx={thick / 2} />
  }
  return null
}

function panelElements(panel: CabinetFrontPanel, box: Rect, cls: ClassMap, key: string): ReactNode[] {
  const a = abs(panel, box)
  if (a.w <= 0 || a.h <= 0) return []
  const out: ReactNode[] = []
  const rx = Math.min(a.w, a.h) * 0.05
  const rail = Math.min(Math.min(a.w, a.h) * 0.16, a.w * 0.3, a.h * 0.3)
  const isGlass = panel.type === 'glass'
  // Внешняя рамка фасада (shaker stile/rail).
  out.push(<rect key={`${key}-o`} className={cls.door} x={a.x} y={a.y} width={a.w} height={a.h} rx={rx} />)
  // Утопленная плоская филёнка.
  const iw = a.w - 2 * rail
  const ih = a.h - 2 * rail
  if (iw > 0 && ih > 0) {
    out.push(
      <rect
        key={`${key}-i`}
        className={isGlass ? cls.glass : cls.recess}
        x={a.x + rail}
        y={a.y + rail}
        width={iw}
        height={ih}
        rx={rx * 0.6}
      />,
    )
    if (isGlass) {
      // Расстекловка витрины: одна вертикаль + одна горизонталь.
      const midX = a.x + a.w / 2
      const midY = a.y + a.h / 2
      out.push(<line key={`${key}-gv`} className={cls.recess} x1={midX} y1={a.y + rail} x2={midX} y2={a.y + a.h - rail} />)
      out.push(<line key={`${key}-gh`} className={cls.recess} x1={a.x + rail} y1={midY} x2={a.x + a.w - rail} y2={midY} />)
    }
  }
  const pull = pullElement(a, panel.pull, panel.pullAt, cls.pull, `${key}-p`)
  if (pull) out.push(pull)
  return out
}

function applianceElements(kind: CabinetFrontApplianceKind, box: Rect, cls: ClassMap): ReactNode[] {
  const out: ReactNode[] = []
  const { x, y, w, h } = box
  // Единый корпус прибора (нержавейка/тёплый тон вместо тонировки корпуса шкафа).
  out.push(<rect key="ap-body" className={cls.appliance} x={x} y={y} width={w} height={h} rx={Math.min(w, h) * 0.05} />)
  if (kind === 'dishwasher') {
    out.push(<line key="dw-ctrl" className={cls.applianceLine} x1={x + w * 0.12} y1={y + h * 0.2} x2={x + w * 0.88} y2={y + h * 0.2} />)
    out.push(<line key="dw-handle" className={cls.applianceLine} x1={x + w * 0.2} y1={y + h * 0.32} x2={x + w * 0.8} y2={y + h * 0.32} />)
  } else if (kind === 'range') {
    out.push(<circle key="rg-b1" className={cls.applianceLine} cx={x + w * 0.32} cy={y + h * 0.2} r={Math.min(w, h) * 0.1} />)
    out.push(<circle key="rg-b2" className={cls.applianceLine} cx={x + w * 0.68} cy={y + h * 0.2} r={Math.min(w, h) * 0.1} />)
    out.push(<rect key="rg-oven" className={cls.applianceLine} x={x + w * 0.16} y={y + h * 0.42} width={w * 0.68} height={h * 0.44} rx={Math.min(w, h) * 0.04} fill="none" />)
    out.push(<line key="rg-h" className={cls.applianceLine} x1={x + w * 0.3} y1={y + h * 0.5} x2={x + w * 0.7} y2={y + h * 0.5} />)
  } else if (kind === 'refrigerator') {
    out.push(<line key="rf-v" className={cls.applianceLine} x1={x + w / 2} y1={y + h * 0.06} x2={x + w / 2} y2={y + h * 0.94} />)
    out.push(<line key="rf-h" className={cls.applianceLine} x1={x + w * 0.06} y1={y + h * 0.42} x2={x + w * 0.94} y2={y + h * 0.42} />)
    out.push(<line key="rf-hl" className={cls.applianceLine} x1={x + w * 0.42} y1={y + h * 0.14} x2={x + w * 0.42} y2={y + h * 0.34} />)
    out.push(<line key="rf-hr" className={cls.applianceLine} x1={x + w * 0.58} y1={y + h * 0.5} x2={x + w * 0.58} y2={y + h * 0.82} />)
  } else if (kind === 'hood') {
    out.push(<path key="hd-trap" className={cls.applianceLine} d={`M ${x + w * 0.2} ${y + h * 0.28} H ${x + w * 0.8} L ${x + w * 0.92} ${y + h * 0.78} H ${x + w * 0.08} Z`} fill="none" />)
  } else if (kind === 'wine') {
    // Диагональная решётка винной стойки.
    for (let i = 0; i <= 4; i += 1) {
      const t = i / 4
      out.push(<line key={`wn-a${i}`} className={cls.applianceLine} x1={x + w * t} y1={y} x2={x + w} y2={y + h * (1 - t)} />)
      out.push(<line key={`wn-b${i}`} className={cls.applianceLine} x1={x} y1={y + h * t} x2={x + w * (1 - t)} y2={y + h} />)
    }
  }
  return out
}

export type CabinetFrontProps = {
  code: string
  widthIn: number
  heightIn: number
  x: number
  y: number
  width: number
  height: number
  variant?: CabinetFrontVariant
  style?: CabinetFrontStyle
  showLabel?: boolean
  drawCarcass?: boolean
  countertopLineY?: number
}

// Рисует фронт шкафа (fragment SVG-элементов) в бокс (x,y,width,height).
export function CabinetFront({
  code,
  widthIn,
  heightIn,
  x,
  y,
  width,
  height,
  variant = 'elevation',
  style = 'shaker',
  showLabel = true,
  drawCarcass = true,
  countertopLineY,
}: CabinetFrontProps): ReactNode {
  const layout = computeCabinetFrontLayout(code, widthIn, heightIn, style)
  const cls = variant === 'gallery' ? GALLERY_CLASSES : ELEVATION_CLASSES
  const box: Rect = { x, y, w: width, h: height }
  const details: ReactNode[] = []

  // Toe-kick у баз/высоких: реквизит внизу.
  if (layout.toeKick) {
    const toeH = layout.toeKickFrac * height
    details.push(
      <rect
        key="toe"
        className={cls.toe}
        x={x + width * 0.06}
        y={y + height - toeH}
        width={width * 0.88}
        height={toeH}
        rx={Math.min(width, height) * 0.01}
      />,
    )
    if (typeof countertopLineY === 'number') {
      details.push(<line key="counter" className={cls.counter} x1={x - width * 0.02} y1={countertopLineY} x2={x + width + width * 0.02} y2={countertopLineY} />)
    }
  }

  if (layout.kind === 'appliance' && layout.appliance) {
    details.push(...applianceElements(layout.appliance, box, cls))
  } else if (layout.kind === 'filler') {
    // Ручной/авто филлер: узкая полоса + диагональная штриховка.
    const a = abs(layout.panels[0] ?? { x: EDGE, y: EDGE, w: 1 - 2 * EDGE, h: 1 - 2 * EDGE }, box)
    for (let i = 1; i <= 4; i += 1) {
      const yy = a.y + (a.h * i) / 5
      details.push(<line key={`fh-${i}`} className={cls.hatch} x1={a.x} y1={yy} x2={a.x + a.w} y2={yy - a.h / 5} />)
    }
  } else if (layout.kind === 'panel') {
    // Торцевая панель: вертикальная «древесная» разлиновка.
    const a = abs(layout.panels[0] ?? { x: EDGE, y: EDGE, w: 1 - 2 * EDGE, h: 1 - 2 * EDGE }, box)
    for (let i = 1; i <= 3; i += 1) {
      const xx = a.x + (a.w * i) / 4
      details.push(<line key={`pg-${i}`} className={cls.grain} x1={xx} y1={a.y} x2={xx} y2={a.y + a.h} />)
    }
  } else {
    layout.panels.forEach((panel, i) => {
      details.push(...panelElements(panel, box, cls, `p${i}`))
    })
  }

  if (showLabel && layout.code) {
    details.push(
      <text key="code" className={cls.label} x={x + width / 2} y={y + height / 2} textAnchor="middle" dominantBaseline="central">
        {layout.code}
      </text>,
    )
  }

  return (
    <>
      {drawCarcass && <rect x={x} y={y} width={width} height={height} rx={Math.min(width, height) * 0.03} />}
      <g className={cls.front}>{details}</g>
    </>
  )
}

// Обёртка для галереи: самодостаточный <svg> с корректной пропорцией фронта (letterbox),
// чтобы навесной был широким/низким, а pantry — высоким. Крупная узнаваемая карточка.
export type CabinetFrontThumbProps = {
  code: string
  widthIn: number
  heightIn: number
  style?: CabinetFrontStyle
  className?: string
}

const THUMB_VB_W = 132
const THUMB_VB_H = 108
const THUMB_PAD = 8

export function CabinetFrontThumb({ code, widthIn, heightIn, style = 'shaker', className }: CabinetFrontThumbProps): ReactNode {
  const layout = computeCabinetFrontLayout(code, widthIn, heightIn, style)
  const innerW = THUMB_VB_W - 2 * THUMB_PAD
  const innerH = THUMB_VB_H - 2 * THUMB_PAD
  const aspect = layout.widthIn / layout.heightIn
  let w = innerW
  let h = innerW / aspect
  if (h > innerH) {
    h = innerH
    w = innerH * aspect
  }
  const x = (THUMB_VB_W - w) / 2
  const y = (THUMB_VB_H - h) / 2
  return (
    <svg
      className={className ? `hub-sketch-cabinet-front ${className}` : 'hub-sketch-cabinet-front'}
      viewBox={`0 0 ${THUMB_VB_W} ${THUMB_VB_H}`}
      aria-hidden="true"
      focusable="false"
    >
      <CabinetFront
        code={code}
        widthIn={widthIn}
        heightIn={heightIn}
        x={x}
        y={y}
        width={w}
        height={h}
        variant="gallery"
        style={style}
        showLabel={false}
      />
    </svg>
  )
}
