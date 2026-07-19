import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useI18n } from '../../lib/i18n'
import {
  DEFAULT_DOOR_HEIGHT_FT,
  DEFAULT_DOOR_WIDTH_FT,
  DEFAULT_WINDOW_HEIGHT_FT,
  DEFAULT_WINDOW_SILL_FT,
  DEFAULT_WINDOW_WIDTH_FT,
  DEFAULT_GROUT_COLOR,
  DEFAULT_TILE_COLOR,
  DEFAULT_WALL_PAINT,
  cleanColor,
  finishCoverageBoundsFt,
  normalizeDrywallPatchSurface,
  normalizeTileSurface,
  resizeSketchSegmentToLength,
  type Opening,
  type Pt,
  type Sketch3DModel,
  type SketchMeasurement,
  type SketchSegmentResizeAnchor,
  type SketchSegmentResizeConflict,
  type SketchSurfaceFinish,
} from './sketchFinishes'
import { formatFeetInches, parseFeetInches, snapFeetToPrecision } from './inches'
import {
  codeClearanceItemIds,
  formatCodeClearanceMessage,
  getCodeClearanceChecks,
  type CodeClearanceCheck,
} from './code-clearances'
import {
  isShowerPanPlacedCatalogItem,
  isToiletPlacedCatalogItem,
  sanitizePlacedCatalogItems,
  showerPanShapeFromPlacedItem,
  type SketchPlacedCatalogItem,
  type SketchShowerPanShape,
} from './sketchCatalog'
import {
  CABINET_COUNTERTOP_HEIGHT_IN,
  CABINET_TOE_KICK_IN,
  CABINET_WALL_BOTTOM_IN,
  cabinetDisplayCode,
  isCabinetPlacedItem,
} from './cabinetCodes'

const CELL_FT = 1

type WallElevationWall = {
  c: number
  s: number
  a: Pt
  b: Pt
}

interface WallElevationProps {
  model: Sketch3DModel & { placedItems?: SketchPlacedCatalogItem[] }
  wall: WallElevationWall
  heightFt: number
  finish: SketchSurfaceFinish
  canEdit?: boolean
  snapStepFt?: number
  codeCheckEnabled?: boolean
  onMeasurementsChange?: (measurements: SketchMeasurement[]) => void
  onModelChange?: (model: Sketch3DModel & { placedItems?: SketchPlacedCatalogItem[] }) => void
}

type ElevationPoint = { x: number; y: number }
type ElevationMeasurementLine = {
  x1: number
  y1: number
  x2: number
  y2: number
  labelX: number
  labelY: number
  angle: number
  text: string
}
type ElevationOpeningBox = {
  x: number
  y: number
  width: number
  openingHeight: number
  floor: number
}
type ElevationOpeningDim = {
  x1: number
  x2: number
  y: number
  text: string
  gap: boolean
}
type ElevationPlacedItem = {
  item: SketchPlacedCatalogItem
  x: number
  y: number
  width: number
  height: number
  warning: boolean
  toilet: boolean
  showerPan: boolean
  showerPanShape: SketchShowerPanShape
  cabinet: boolean
  cabinetCode: string
  filler: boolean
  layer?: 'base' | 'wall'
}

function modelCellFt(model: Sketch3DModel): number {
  return Number.isFinite(model.cellFt) && model.cellFt > 0 ? model.cellFt : CELL_FT
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function openingWidthFt(opening: Opening): number {
  return opening.w ?? (opening.kind === 'door' ? DEFAULT_DOOR_WIDTH_FT : DEFAULT_WINDOW_WIDTH_FT)
}

function openingHeightFt(opening: Opening): number {
  return opening.kind === 'door' ? (opening.h ?? DEFAULT_DOOR_HEIGHT_FT) : (opening.h ?? DEFAULT_WINDOW_HEIGHT_FT)
}

function openingFloorFt(opening: Opening): number {
  return opening.kind === 'door' ? 0 : (opening.sill ?? DEFAULT_WINDOW_SILL_FT)
}

function formatLength(valueFt: number): string {
  return formatFeetInches((Number.isFinite(valueFt) ? valueFt : 0) * 12)
}

function snapLengthFt(valueFt: number, stepFt: number): number {
  const step = Number.isFinite(stepFt) && stepFt > 0 ? stepFt : 1 / 96
  return Math.round(valueFt / step) * step
}

function ticks(max: number, step: number): number[] {
  const count = Math.min(240, Math.floor(max / step) + 1)
  return Array.from({ length: count }, (_, index) => index * step).filter((value) => value <= max + 0.0001)
}

function readableSvgAngle(dx: number, dy: number): number {
  let angle = (Math.atan2(dy, dx) * 180) / Math.PI
  if (angle > 90 || angle < -90) angle += 180
  return angle
}

function wallKey(wall: WallElevationWall): string {
  return `${wall.c}:${wall.s}`
}

function itemAxes(item: SketchPlacedCatalogItem): { side: { x: number; z: number }; forward: { x: number; z: number } } {
  const c = Math.cos(item.rotationY)
  const s = Math.sin(item.rotationY)
  return {
    side: { x: c, z: -s },
    forward: { x: s, z: c },
  }
}

function itemFootprintCorners(item: SketchPlacedCatalogItem, widthFt: number, depthFt: number) {
  const axes = itemAxes(item)
  const halfW = widthFt / 2
  const halfD = depthFt / 2
  return [
    { x: item.xFt - axes.side.x * halfW - axes.forward.x * halfD, z: item.zFt - axes.side.z * halfW - axes.forward.z * halfD },
    { x: item.xFt + axes.side.x * halfW - axes.forward.x * halfD, z: item.zFt + axes.side.z * halfW - axes.forward.z * halfD },
    { x: item.xFt + axes.side.x * halfW + axes.forward.x * halfD, z: item.zFt + axes.side.z * halfW + axes.forward.z * halfD },
    { x: item.xFt - axes.side.x * halfW + axes.forward.x * halfD, z: item.zFt - axes.side.z * halfW + axes.forward.z * halfD },
  ]
}

function elevationPlacedItems(
  model: Sketch3DModel & { placedItems?: SketchPlacedCatalogItem[] },
  wall: WallElevationWall,
  lengthFt: number,
  height: number,
  warningIds: Set<string>,
): ElevationPlacedItem[] {
  const cellFt = modelCellFt(model)
  const ax = wall.a.x * cellFt
  const az = wall.a.y * cellFt
  const bx = wall.b.x * cellFt
  const bz = wall.b.y * cellFt
  const wallLen = Math.hypot(bx - ax, bz - az)
  if (wallLen <= 0.001) return []
  const ux = (bx - ax) / wallLen
  const uz = (bz - az) / wallLen
  return sanitizePlacedCatalogItems(model.placedItems)
    .map((item): ElevationPlacedItem | null => {
      if (item.surface === 'ceiling' || item.category === 'light' || item.category === 'fan') return null
      if (item.c !== wall.c || item.s !== wall.s) return null
      const widthIn = Number(item.widthIn)
      const depthIn = Number(item.depthIn)
      const heightIn = Number(item.heightIn)
      if (!Number.isFinite(widthIn) || !Number.isFinite(depthIn) || !Number.isFinite(heightIn) || widthIn <= 0 || depthIn <= 0 || heightIn <= 0) return null
      const widthFt = widthIn / 12
      const depthFt = depthIn / 12
      const heightFt = Math.min(height, heightIn / 12)
      const projections = itemFootprintCorners(item, widthFt, depthFt).map((point) => (point.x - ax) * ux + (point.z - az) * uz)
      const minX = Math.max(0, Math.min(lengthFt, Math.min(...projections)))
      const maxX = Math.max(0, Math.min(lengthFt, Math.max(...projections)))
      const projectedWidth = Math.max(0.12, maxX - minX)
      const centerX = Number.isFinite(item.t) ? Math.max(0, Math.min(lengthFt, (item.t ?? 0.5) * lengthFt)) : (minX + maxX) / 2
      const bottomFt = Math.max(0, Math.min(height, Number.isFinite(item.yFt) ? item.yFt - heightFt / 2 : 0))
      const drawnHeight = Math.min(heightFt, Math.max(0.08, height - bottomFt))
      const cabinet = isCabinetPlacedItem(item)
      return {
        item,
        x: Math.max(0, Math.min(lengthFt - projectedWidth, centerX - projectedWidth / 2)),
        y: Math.max(0, height - bottomFt - drawnHeight),
        width: projectedWidth,
        height: drawnHeight,
        warning: warningIds.has(item.id) || !!item.layoutWarning,
        toilet: isToiletPlacedCatalogItem(item),
        showerPan: isShowerPanPlacedCatalogItem(item),
        showerPanShape: showerPanShapeFromPlacedItem(item),
        cabinet,
        cabinetCode: cabinet ? cabinetDisplayCode(item) : '',
        filler: item.filler === true,
        layer: item.layer,
      }
    })
    .filter((item): item is ElevationPlacedItem => !!item)
}

function elevationMeasurementLine(measurement: SketchMeasurement, height: number): ElevationMeasurementLine | null {
  const x1 = measurement.a.x
  const y1 = height - measurement.a.y
  const x2 = measurement.b.x
  const y2 = height - measurement.b.y
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy)
  if (len <= 0.001) return null
  const nx = -dy / len
  const ny = dx / len
  const labelGap = 0.22
  return {
    x1,
    y1,
    x2,
    y2,
    labelX: (x1 + x2) / 2 + nx * labelGap,
    labelY: (y1 + y2) / 2 + ny * labelGap,
    angle: readableSvgAngle(dx, dy),
    text: formatLength(len),
  }
}

function elevationOpeningBox(opening: Opening, lengthFt: number, height: number): ElevationOpeningBox {
  const width = Math.min(openingWidthFt(opening), lengthFt)
  const openingHeight = Math.min(openingHeightFt(opening), height)
  const floor = Math.min(openingFloorFt(opening), Math.max(0, height - openingHeight))
  const x = Math.max(0, Math.min(lengthFt - width, opening.t * lengthFt - width / 2))
  const y = height - floor - openingHeight
  return { x, y, width, openingHeight, floor }
}

function elevationOpeningDims(
  openings: Opening[],
  opening: Opening,
  index: number,
  lengthFt: number,
  height: number,
  t: (key: string) => string,
): ElevationOpeningDim[] {
  const box = elevationOpeningBox(opening, lengthFt, height)
  const above = box.y > 0.55
  const baseY = above
    ? box.y - 0.28 - (index % 2) * 0.18
    : Math.min(height + 0.34 + (index % 2) * 0.18, height + 0.82)
  const gapY = above ? baseY - 0.22 : baseY + 0.22
  const dims: ElevationOpeningDim[] = []
  const push = (x1: number, x2: number, y: number, text: string, gap: boolean) => {
    if (x2 - x1 <= 0.05) return
    dims.push({ x1, x2, y, text, gap })
  }

  push(0, box.x, baseY, `${t('hub_sketch_dim_left_short')} ${formatLength(box.x)}`, false)
  push(box.x + box.width, lengthFt, baseY, `${t('hub_sketch_dim_right_short')} ${formatLength(lengthFt - box.x - box.width)}`, false)

  const boxes = openings.map((item, itemIndex) => ({ index: itemIndex, box: elevationOpeningBox(item, lengthFt, height) }))
  const left = boxes
    .filter((item) => item.index !== index && item.box.x + item.box.width <= box.x + 0.001)
    .sort((a, b) => (b.box.x + b.box.width) - (a.box.x + a.box.width))[0]
  const right = boxes
    .filter((item) => item.index !== index && item.box.x >= box.x + box.width - 0.001)
    .sort((a, b) => a.box.x - b.box.x)[0]
  if (left) {
    const from = left.box.x + left.box.width
    push(from, box.x, gapY, `${t('hub_sketch_dim_gap_short')} ${formatLength(box.x - from)}`, true)
  }
  if (right) {
    const to = right.box.x
    push(box.x + box.width, to, gapY, `${t('hub_sketch_dim_gap_short')} ${formatLength(to - box.x - box.width)}`, true)
  }

  return dims
}

export default function WallElevation({ model, wall, heightFt, finish, canEdit = false, snapStepFt = 1 / 96, codeCheckEnabled = true, onMeasurementsChange, onModelChange }: WallElevationProps) {
  const { t } = useI18n()
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [measureTool, setMeasureTool] = useState(false)
  const [showMeasurements, setShowMeasurements] = useState(true)
  const [draft, setDraft] = useState<ElevationPoint | null>(null)
  const [hover, setHover] = useState<ElevationPoint | null>(null)
  const [selectedMeasurementIndex, setSelectedMeasurementIndex] = useState<number | null>(null)
  const [wallLengthDraft, setWallLengthDraft] = useState<string | null>(null)
  const [wallLengthConflict, setWallLengthConflict] = useState<SketchSegmentResizeConflict | null>(null)
  const cellFt = modelCellFt(model)
  const lengthFt = Math.max(0.01, dist(wall.a, wall.b) * cellFt)
  const height = Math.max(1, heightFt)
  const wallLengthText = formatLength(lengthFt)
  const openings = useMemo(
    () => model.openings.filter((opening) => opening.c === wall.c && opening.s === wall.s),
    [model.openings, wall.c, wall.s],
  )
  const pad = Math.max(0.5, Math.min(1.2, Math.max(lengthFt, height) * 0.08))
  const viewBox = `${-pad} ${-pad} ${lengthFt + pad * 2} ${height + pad * 2}`
  const isTile = finish.kind === 'tile'
  const tile = isTile ? normalizeTileSurface(finish) : null
  const patternId = `wall-elevation-tile-${wall.c}-${wall.s}`
  const patch = finish.kind === 'drywall-patch' ? normalizeDrywallPatchSurface(finish) : null
  const finishCoverage = finishCoverageBoundsFt(finish, height)
  const surfaceFill = isTile ? `url(#${patternId})` : cleanColor(finish.kind === 'paint' ? finish.color : patch?.patchColor, DEFAULT_WALL_PAINT)
  const baseFill = patch ? cleanColor(patch.baseColor, DEFAULT_WALL_PAINT) : DEFAULT_WALL_PAINT
  const groutColor = cleanColor(tile?.groutColor, DEFAULT_GROUT_COLOR)
  const tileColor = cleanColor(tile?.tileColor, DEFAULT_TILE_COLOR)
  const tileW = Math.max(1, tile?.tileWIn ?? 12) / 12
  const tileH = Math.max(1, tile?.tileHIn ?? 24) / 12
  const grout = Math.max(0, tile?.groutIn ?? 0.125) / 12
  const currentWallKey = wallKey(wall)
  const codeClearanceChecks = useMemo(
    () => (codeCheckEnabled ? getCodeClearanceChecks(model) : []),
    [model, codeCheckEnabled],
  )
  const codeClearanceViolations = useMemo(
    () => codeClearanceChecks.filter((check) => !check.ok),
    [codeClearanceChecks],
  )
  const codeWarningItemIds = useMemo(() => codeClearanceItemIds(codeClearanceViolations), [codeClearanceViolations])
  const wallPlacedItems = useMemo(
    () => elevationPlacedItems(model, wall, lengthFt, height, codeWarningItemIds),
    [model, wall, lengthFt, height, codeWarningItemIds],
  )
  const wallCabinetCount = wallPlacedItems.filter((entry) => entry.cabinet).length
  const wallCodeViolations = useMemo(
    () => codeClearanceViolations.filter((check) => {
      const onWall = (entity: CodeClearanceCheck['subject']) => entity.wall && `${entity.wall.c}:${entity.wall.s}` === currentWallKey
      return onWall(check.subject) || onWall(check.target) || wallPlacedItems.some((entry) => entry.item.id === check.subject.id || entry.item.id === check.target.id)
    }),
    [codeClearanceViolations, currentWallKey, wallPlacedItems],
  )
  const wallMeasurements = useMemo(
    () => (model.measurements ?? [])
      .map((measurement, index) => ({ measurement, index }))
      .filter(({ measurement }) => measurement.scope === 'wall' && measurement.wallKey === currentWallKey),
    [model.measurements, currentWallKey],
  )
  const measurementLines = useMemo(
    () => wallMeasurements
      .map((entry) => ({ ...entry, line: elevationMeasurementLine(entry.measurement, height) }))
      .filter((entry): entry is { measurement: SketchMeasurement; index: number; line: ElevationMeasurementLine } => !!entry.line),
    [wallMeasurements, height],
  )
  const previewLine = draft && hover ? elevationMeasurementLine({ scope: 'wall', wallKey: currentWallKey, a: draft, b: hover }, height) : null
  const wallLengthConflictActive = wallLengthConflict?.segments.some((segment) => segment.c === wall.c && segment.s === wall.s) ?? false
  const wallDimY = height + Math.min(0.32, pad * 0.55)
  const wallDimLabelY = Math.min(height + pad - 0.12, wallDimY + 0.18)
  const wallDimInputW = Math.min(Math.max(1.55, lengthFt * 0.24), Math.max(1.2, lengthFt))
  const wallDimInputH = 0.42

  const svgPoint = (clientX: number, clientY: number): ElevationPoint | null => {
    const svg = svgRef.current
    const matrix = svg?.getScreenCTM()
    if (!svg || !matrix) return null
    const point = svg.createSVGPoint()
    point.x = clientX
    point.y = clientY
    const local = point.matrixTransform(matrix.inverse())
    return {
      x: snapLengthFt(Math.max(0, Math.min(lengthFt, local.x)), snapStepFt),
      y: snapLengthFt(Math.max(0, Math.min(height, height - local.y)), snapStepFt),
    }
  }

  const updateMeasurements = (nextMeasurements: SketchMeasurement[]) => {
    onMeasurementsChange?.(nextMeasurements)
  }

  const beginWallLengthEdit = () => {
    if (!canEdit || !onModelChange) return
    setWallLengthDraft(wallLengthText)
    setWallLengthConflict(null)
    setSelectedMeasurementIndex(null)
    setDraft(null)
  }

  const cancelWallLengthEdit = () => {
    setWallLengthDraft(null)
    setWallLengthConflict(null)
  }

  const applyWallLengthDraft = (anchor: SketchSegmentResizeAnchor = 'start') => {
    if (wallLengthDraft === null || !onModelChange) return
    const parsed = parseFeetInches(wallLengthDraft)
    if (!Number.isFinite(parsed)) {
      setWallLengthConflict({ reason: 'invalid-length', segments: [{ c: wall.c, s: wall.s }] })
      return
    }
    const result = resizeSketchSegmentToLength(model, { c: wall.c, s: wall.s }, snapFeetToPrecision(parsed / 12), { anchor })
    if (!result.ok) {
      setWallLengthConflict(result.conflict)
      return
    }
    onModelChange(result.model)
    setWallLengthDraft(null)
    setWallLengthConflict(null)
  }

  const removeMeasurement = (index: number) => {
    const measurements = model.measurements ?? []
    if (!measurements[index]) return
    updateMeasurements(measurements.filter((_, i) => i !== index))
    setSelectedMeasurementIndex(null)
    setDraft(null)
  }

  useEffect(() => {
    setDraft(null)
    setHover(null)
    setSelectedMeasurementIndex(null)
    setWallLengthDraft(null)
    setWallLengthConflict(null)
  }, [currentWallKey])

  useEffect(() => {
    if (!measureTool) {
      setDraft(null)
      setHover(null)
    }
  }, [measureTool])

  useEffect(() => {
    if (!canEdit) return
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)) return
      if (event.key === 'Escape' && measureTool) {
        setMeasureTool(false)
        setDraft(null)
        event.preventDefault()
        return
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedMeasurementIndex !== null) {
        removeMeasurement(selectedMeasurementIndex)
        event.preventDefault()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [canEdit, measureTool, selectedMeasurementIndex, model, onMeasurementsChange])

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!canEdit || !measureTool) return
    setHover(svgPoint(event.clientX, event.clientY))
  }

  const handleClick = (event: ReactMouseEvent<SVGSVGElement>) => {
    if (!canEdit || !measureTool) return
    const point = svgPoint(event.clientX, event.clientY)
    if (!point) return
    setShowMeasurements(true)
    setSelectedMeasurementIndex(null)
    if (!draft) {
      setDraft(point)
      return
    }
    if (Math.hypot(point.x - draft.x, point.y - draft.y) <= 0.001) return
    const nextMeasurement: SketchMeasurement = {
      id: `measure-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      scope: 'wall',
      wallKey: currentWallKey,
      a: draft,
      b: point,
    }
    updateMeasurements([...(model.measurements ?? []), nextMeasurement])
    setSelectedMeasurementIndex((model.measurements ?? []).length)
    setDraft(null)
  }

  const deleteButtonKeyDown = (index: number) => (event: ReactKeyboardEvent<SVGGElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    event.stopPropagation()
    removeMeasurement(index)
  }

  return (
    <div className="hub-sketch-elevation">
        <div className="hub-sketch-elevation-meta">
        <button
          type="button"
          className={wallLengthConflictActive ? 'hub-sketch-elevation-meta-button hub-sketch-elevation-meta-button-conflict' : 'hub-sketch-elevation-meta-button'}
          disabled={!canEdit || !onModelChange}
          onClick={beginWallLengthEdit}
        >
          {`${t('hub_sketch_dim_length_short')}: ${wallLengthText}`}
        </button>
        <span>{`${t('hub_sketch_dim_height_short')}: ${formatLength(height)}`}</span>
        <span>{`${t('hub_sketch_3d_openings')}: ${openings.length}`}</span>
        {!finishCoverage.full && <span>{`${t('hub_sketch_finish_coverage')}: ${formatLength(finishCoverage.topFt - finishCoverage.bottomFt)}`}</span>}
        {wallCabinetCount > 0 && <span>{`${t('hub_sketch_tool_cabinet')}: ${wallCabinetCount}`}</span>}
      </div>
      <div className="hub-sketch-elevation-tools">
        {canEdit && (
          <button
            type="button"
            className={measureTool ? 'btn small' : 'btn ghost small'}
            aria-pressed={measureTool}
            onClick={() => setMeasureTool((current) => !current)}
          >
            <span aria-hidden="true">📏</span>
            <span>{t('hub_sketch_tool_measure')}</span>
          </button>
        )}
        <label className="hub-sketch-layer-toggle">
          <input
            type="checkbox"
            checked={showMeasurements}
            onChange={(event) => {
              setShowMeasurements(event.target.checked)
              if (!event.target.checked) setSelectedMeasurementIndex(null)
            }}
          />
          <span>{t('hub_sketch_measurements')}</span>
        </label>
      </div>
      {wallLengthConflict && wallLengthDraft !== null && (
        <div className="hub-sketch-elevation-conflict" role="alertdialog" aria-live="polite">
          <span>{t('hub_sketch_dimension_conflict_prompt')}</span>
          <button type="button" className="btn small" onMouseDown={(event) => event.preventDefault()} onClick={() => applyWallLengthDraft('end')}>
            {t('hub_sketch_dimension_move_start')}
          </button>
          <button type="button" className="btn small" onMouseDown={(event) => event.preventDefault()} onClick={() => applyWallLengthDraft('start')}>
            {t('hub_sketch_dimension_move_end')}
          </button>
          <button type="button" className="btn ghost small" onMouseDown={(event) => event.preventDefault()} onClick={cancelWallLengthEdit}>
            {t('cancel')}
          </button>
        </div>
      )}
      {codeCheckEnabled && wallCodeViolations.length > 0 && (
        <div className="hub-sketch-elevation-code-list" role="status" aria-live="polite">
          {wallCodeViolations.slice(0, 3).map((check) => (
            <span key={check.id} className="hub-sketch-code-chip">
              {formatCodeClearanceMessage(check, t)}
            </span>
          ))}
        </div>
      )}
      <svg
        ref={svgRef}
        className="hub-sketch-elevation-svg"
        viewBox={viewBox}
        role="img"
        aria-label={t('hub_sketch_3d_wall_elevation')}
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setHover(null)}
        onClick={handleClick}
      >
        <defs>
          <marker id={`hub-sketch-elevation-measure-arrow-${wall.c}-${wall.s}`} viewBox="0 0 8 8" refX="4" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 8 4 L 0 8 z" fill="#047857" />
          </marker>
          {isTile && (
            <pattern id={patternId} width={tileW + grout} height={tileH + grout} patternUnits="userSpaceOnUse">
              <rect width={tileW + grout} height={tileH + grout} fill={groutColor} />
              <rect width={tileW} height={tileH} fill={tileColor} />
            </pattern>
          )}
        </defs>
        <rect className="hub-sketch-elevation-wall" x={0} y={0} width={lengthFt} height={height} fill={baseFill} />
        {patch ? (
          <rect
            className="hub-sketch-elevation-drywall-patch"
            x={Math.max(0, Math.min(lengthFt - Math.min(lengthFt, patch.widthFt ?? 0), patch.xFt ?? 0))}
            y={height - Math.max(0, Math.min(height, (patch.yFt ?? 0) + (patch.heightFt ?? 0)))}
            width={Math.min(lengthFt, patch.widthFt ?? 0)}
            height={Math.min(height, patch.heightFt ?? 0)}
            fill={surfaceFill}
          />
        ) : (
          <rect
            className={finishCoverage.full ? 'hub-sketch-elevation-finish' : 'hub-sketch-elevation-finish hub-sketch-elevation-finish-partial'}
            x={0}
            y={height - finishCoverage.topFt}
            width={lengthFt}
            height={Math.max(0.001, finishCoverage.topFt - finishCoverage.bottomFt)}
            fill={surfaceFill}
          />
        )}
        <g className="hub-sketch-elevation-grid">
          {ticks(lengthFt, 0.5).map((x) => (
            <line key={`x${x}`} x1={x} y1={0} x2={x} y2={height} className={Math.abs(x - Math.round(x)) < 0.001 ? 'major' : undefined} />
          ))}
          {ticks(height, 0.5).map((y) => (
            <line key={`y${y}`} x1={0} y1={height - y} x2={lengthFt} y2={height - y} className={Math.abs(y - Math.round(y)) < 0.001 ? 'major' : undefined} />
          ))}
        </g>
        <g className="hub-sketch-elevation-cabinet-guides">
          {[
            { key: 'toe', value: CABINET_TOE_KICK_IN / 12, label: t('hub_sketch_cabinet_toe_guide') },
            { key: 'counter', value: CABINET_COUNTERTOP_HEIGHT_IN / 12, label: t('hub_sketch_cabinet_counter_guide') },
            { key: 'wall', value: CABINET_WALL_BOTTOM_IN / 12, label: t('hub_sketch_cabinet_wall_guide') },
          ].filter((guide) => guide.value < height).map((guide) => (
            <g key={guide.key}>
              <line x1={0} y1={height - guide.value} x2={lengthFt} y2={height - guide.value} />
              <text x={0.08} y={height - guide.value - 0.05} textAnchor="start">{guide.label}</text>
            </g>
          ))}
        </g>
        <rect className={wallLengthConflictActive ? 'hub-sketch-elevation-outline hub-sketch-elevation-outline-conflict' : 'hub-sketch-elevation-outline'} x={0} y={0} width={lengthFt} height={height} />
        <g className={wallLengthConflictActive ? 'hub-sketch-elevation-wall-dim hub-sketch-elevation-wall-dim-conflict' : 'hub-sketch-elevation-wall-dim'}>
          <line x1={0} y1={wallDimY} x2={lengthFt} y2={wallDimY} />
          <line x1={0} y1={wallDimY - 0.1} x2={0} y2={wallDimY + 0.1} />
          <line x1={lengthFt} y1={wallDimY - 0.1} x2={lengthFt} y2={wallDimY + 0.1} />
          {wallLengthDraft !== null ? (
            <foreignObject x={Math.max(0, lengthFt / 2 - wallDimInputW / 2)} y={wallDimLabelY - wallDimInputH / 2} width={wallDimInputW} height={wallDimInputH}>
              <input
                className="hub-sketch-elevation-dim-input"
                value={wallLengthDraft}
                inputMode="text"
                autoFocus
                aria-label={t('hub_sketch_dimension_edit_label')}
                onChange={(event) => setWallLengthDraft(event.target.value)}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
                onBlur={() => applyWallLengthDraft()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    applyWallLengthDraft()
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    cancelWallLengthEdit()
                  }
                }}
              />
            </foreignObject>
          ) : (
            <text
              x={lengthFt / 2}
              y={wallDimLabelY}
              textAnchor="middle"
              role={canEdit && onModelChange ? 'button' : undefined}
              tabIndex={canEdit && onModelChange ? 0 : undefined}
              aria-label={canEdit && onModelChange ? t('hub_sketch_dimension_edit_label') : undefined}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                beginWallLengthEdit()
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                beginWallLengthEdit()
              }}
            >
              {wallLengthText}
            </text>
          )}
        </g>
        {openings.map((opening, index) => {
          const box = elevationOpeningBox(opening, lengthFt, height)
          const label = opening.kind === 'door'
            ? `${formatLength(box.width)} x ${formatLength(box.openingHeight)}`
            : `${formatLength(box.width)} x ${formatLength(box.openingHeight)} / ${formatLength(box.floor)}`
          const dims = elevationOpeningDims(openings, opening, index, lengthFt, height, t)
          return (
            <g key={`${opening.kind}-${index}`}>
              <rect
                className={opening.kind === 'door' ? 'hub-sketch-elevation-door' : 'hub-sketch-elevation-window'}
                x={box.x}
                y={box.y}
                width={box.width}
                height={box.openingHeight}
              >
                <title>{label}</title>
              </rect>
              <text x={box.x + box.width / 2} y={Math.max(0.28, box.y - 0.14)} textAnchor="middle">
                {label}
              </text>
              {dims.map((dim, dimIndex) => {
                const tick = 0.09
                const labelY = dim.y - 0.07
                return (
                  <g
                    key={`od-${dimIndex}`}
                    className={dim.gap ? 'hub-sketch-elevation-opening-dim hub-sketch-elevation-opening-dim-gap' : 'hub-sketch-elevation-opening-dim'}
                  >
                    <line x1={dim.x1} y1={dim.y} x2={dim.x2} y2={dim.y} />
                    <line x1={dim.x1} y1={dim.y - tick} x2={dim.x1} y2={dim.y + tick} />
                    <line x1={dim.x2} y1={dim.y - tick} x2={dim.x2} y2={dim.y + tick} />
                    <text x={(dim.x1 + dim.x2) / 2} y={labelY} textAnchor="middle">
                      {dim.text}
                    </text>
                  </g>
                )
              })}
            </g>
          )
        })}
        {wallPlacedItems.map((entry) => {
          const cls = `hub-sketch-elevation-item${entry.warning ? ' hub-sketch-elevation-item-warn' : ''}${entry.toilet ? ' hub-sketch-elevation-toilet' : ''}${entry.showerPan ? ' hub-sketch-elevation-shower' : ''}${entry.cabinet ? ' hub-sketch-elevation-cabinet' : ''}${entry.layer === 'wall' ? ' hub-sketch-elevation-cabinet-wall' : ''}${entry.filler ? ' hub-sketch-elevation-cabinet-filler' : ''}`
          return (
            <g key={`ei-${entry.item.id}`} className={cls}>
              <title>{entry.item.name ?? (entry.toilet ? t('hub_sketch_toilet') : entry.cabinet ? entry.cabinetCode : t('hub_sketch_code_target_item'))}</title>
              {entry.toilet ? (
                <>
                  <rect x={entry.x + entry.width * 0.08} y={entry.y + entry.height * 0.02} width={entry.width * 0.84} height={entry.height * 0.36} rx={0.05} />
                  <path d={`M ${entry.x + entry.width * 0.18} ${entry.y + entry.height * 0.38} C ${entry.x + entry.width * 0.2} ${entry.y + entry.height * 0.78}, ${entry.x + entry.width * 0.8} ${entry.y + entry.height * 0.78}, ${entry.x + entry.width * 0.82} ${entry.y + entry.height * 0.38} Z`} />
                  <ellipse cx={entry.x + entry.width / 2} cy={entry.y + entry.height * 0.56} rx={entry.width * 0.22} ry={entry.height * 0.13} />
                </>
              ) : entry.showerPan ? (
                <>
                  {entry.showerPanShape === 'neo-angle' ? (
                    <path d={`M ${entry.x} ${entry.y} H ${entry.x + entry.width} V ${entry.y + entry.height * 0.62} L ${entry.x + entry.width * 0.62} ${entry.y + entry.height} H ${entry.x} Z`} />
                  ) : (
                    <rect x={entry.x} y={entry.y} width={entry.width} height={entry.height} rx={0.03} />
                  )}
                  <line className="hub-sketch-elevation-shower-rim" x1={entry.x + entry.width * 0.08} y1={entry.y + entry.height * 0.48} x2={entry.x + entry.width * 0.92} y2={entry.y + entry.height * 0.48} />
                </>
              ) : entry.cabinet ? (
                <>
                  <rect x={entry.x} y={entry.y} width={entry.width} height={entry.height} rx={0.025} />
                  {entry.layer === 'base' && !entry.filler && (
                    <>
                      <rect
                        className="hub-sketch-elevation-cabinet-toe"
                        x={entry.x + entry.width * 0.08}
                        y={entry.y + entry.height - Math.min(entry.height * 0.3, CABINET_TOE_KICK_IN / 12)}
                        width={entry.width * 0.84}
                        height={Math.min(entry.height * 0.3, CABINET_TOE_KICK_IN / 12)}
                        rx={0.015}
                      />
                      <line className="hub-sketch-elevation-cabinet-counter" x1={entry.x - 0.02} y1={Math.max(0, height - CABINET_COUNTERTOP_HEIGHT_IN / 12)} x2={entry.x + entry.width + 0.02} y2={Math.max(0, height - CABINET_COUNTERTOP_HEIGHT_IN / 12)} />
                    </>
                  )}
                  <line className="hub-sketch-elevation-cabinet-face" x1={entry.x + entry.width * 0.1} y1={entry.y + entry.height * 0.28} x2={entry.x + entry.width * 0.9} y2={entry.y + entry.height * 0.28} />
                  <line className="hub-sketch-elevation-cabinet-face" x1={entry.x + entry.width / 2} y1={entry.y + entry.height * 0.28} x2={entry.x + entry.width / 2} y2={entry.y + entry.height * 0.9} />
                  {entry.filler && (
                    <path className="hub-sketch-elevation-cabinet-fill-mark" d={`M ${entry.x} ${entry.y} L ${entry.x + entry.width} ${entry.y + entry.height} M ${entry.x + entry.width} ${entry.y} L ${entry.x} ${entry.y + entry.height}`} />
                  )}
                  {entry.cabinetCode && (
                    <text x={entry.x + entry.width / 2} y={entry.y + entry.height / 2} textAnchor="middle" dominantBaseline="central">
                      {entry.cabinetCode}
                    </text>
                  )}
                </>
              ) : (
                <rect x={entry.x} y={entry.y} width={entry.width} height={entry.height} rx={0.05} />
              )}
            </g>
          )
        })}
        {showMeasurements && measurementLines.map(({ index, line }) => {
          const selected = selectedMeasurementIndex === index
          const deleteSize = 0.34
          const deleteX = line.labelX + 0.58
          const deleteY = line.labelY
          return (
            <g
              key={`em${index}`}
              className={selected ? 'hub-sketch-elevation-measurement hub-sketch-elevation-measurement-selected' : 'hub-sketch-elevation-measurement'}
              onClick={(event) => {
                if (!canEdit) return
                event.stopPropagation()
                setSelectedMeasurementIndex(index)
                setDraft(null)
              }}
            >
              <line
                className="hub-sketch-elevation-measurement-line"
                x1={line.x1}
                y1={line.y1}
                x2={line.x2}
                y2={line.y2}
                markerStart={`url(#hub-sketch-elevation-measure-arrow-${wall.c}-${wall.s})`}
                markerEnd={`url(#hub-sketch-elevation-measure-arrow-${wall.c}-${wall.s})`}
              />
              <line className="hub-sketch-elevation-measurement-hit" x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} />
              <text x={line.labelX} y={line.labelY} textAnchor="middle" dominantBaseline="central" transform={`rotate(${line.angle} ${line.labelX} ${line.labelY})`}>
                {line.text}
              </text>
              {selected && (
                <g
                  className="hub-sketch-elevation-measurement-delete"
                  role="button"
                  tabIndex={0}
                  aria-label={t('hub_sketch_measurement_delete')}
                  onClick={(event) => {
                    event.stopPropagation()
                    removeMeasurement(index)
                  }}
                  onKeyDown={deleteButtonKeyDown(index)}
                >
                  <rect x={deleteX - deleteSize / 2} y={deleteY - deleteSize / 2} width={deleteSize} height={deleteSize} rx={0.06} />
                  <text x={deleteX} y={deleteY} textAnchor="middle" dominantBaseline="central">×</text>
                </g>
              )}
            </g>
          )
        })}
        {showMeasurements && canEdit && measureTool && previewLine && (
          <g className="hub-sketch-elevation-measurement hub-sketch-elevation-measurement-preview">
            <line
              className="hub-sketch-elevation-measurement-line"
              x1={previewLine.x1}
              y1={previewLine.y1}
              x2={previewLine.x2}
              y2={previewLine.y2}
              markerStart={`url(#hub-sketch-elevation-measure-arrow-${wall.c}-${wall.s})`}
              markerEnd={`url(#hub-sketch-elevation-measure-arrow-${wall.c}-${wall.s})`}
            />
            <text x={previewLine.labelX} y={previewLine.labelY} textAnchor="middle" dominantBaseline="central" transform={`rotate(${previewLine.angle} ${previewLine.labelX} ${previewLine.labelY})`}>
              {previewLine.text}
            </text>
          </g>
        )}
      </svg>
    </div>
  )
}
