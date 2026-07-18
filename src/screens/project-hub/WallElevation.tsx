import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useI18n } from '../../lib/i18n'
import {
  DEFAULT_GROUT_COLOR,
  DEFAULT_TILE_COLOR,
  DEFAULT_WALL_PAINT,
  cleanColor,
  normalizeTileSurface,
  type Opening,
  type Pt,
  type Sketch3DModel,
  type SketchMeasurement,
  type SketchSurfaceFinish,
} from './sketchFinishes'
import { formatFeetInches } from './inches'

const CELL_FT = 1
const DOOR_W_FT = 3
const DOOR_H_FT = 80 / 12
const WIN_W_FT = 3
const WIN_H_FT = 4
const WIN_SILL_FT = 3

type WallElevationWall = {
  c: number
  s: number
  a: Pt
  b: Pt
}

interface WallElevationProps {
  model: Sketch3DModel
  wall: WallElevationWall
  heightFt: number
  finish: SketchSurfaceFinish
  canEdit?: boolean
  snapStepFt?: number
  onMeasurementsChange?: (measurements: SketchMeasurement[]) => void
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

function modelCellFt(model: Sketch3DModel): number {
  return Number.isFinite(model.cellFt) && model.cellFt > 0 ? model.cellFt : CELL_FT
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function openingWidthFt(opening: Opening): number {
  return opening.w ?? (opening.kind === 'door' ? DOOR_W_FT : WIN_W_FT)
}

function openingHeightFt(opening: Opening): number {
  return opening.kind === 'door' ? (opening.h ?? DOOR_H_FT) : (opening.h ?? WIN_H_FT)
}

function openingFloorFt(opening: Opening): number {
  return opening.kind === 'door' ? 0 : (opening.sill ?? WIN_SILL_FT)
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

export default function WallElevation({ model, wall, heightFt, finish, canEdit = false, snapStepFt = 1 / 96, onMeasurementsChange }: WallElevationProps) {
  const { t } = useI18n()
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [measureTool, setMeasureTool] = useState(false)
  const [showMeasurements, setShowMeasurements] = useState(true)
  const [draft, setDraft] = useState<ElevationPoint | null>(null)
  const [hover, setHover] = useState<ElevationPoint | null>(null)
  const [selectedMeasurementIndex, setSelectedMeasurementIndex] = useState<number | null>(null)
  const cellFt = modelCellFt(model)
  const lengthFt = Math.max(0.01, dist(wall.a, wall.b) * cellFt)
  const height = Math.max(1, heightFt)
  const openings = useMemo(
    () => model.openings.filter((opening) => opening.c === wall.c && opening.s === wall.s),
    [model.openings, wall.c, wall.s],
  )
  const pad = Math.max(0.5, Math.min(1.2, Math.max(lengthFt, height) * 0.08))
  const viewBox = `${-pad} ${-pad} ${lengthFt + pad * 2} ${height + pad * 2}`
  const isTile = finish.kind === 'tile'
  const tile = isTile ? normalizeTileSurface(finish) : null
  const patternId = `wall-elevation-tile-${wall.c}-${wall.s}`
  const fill = isTile ? `url(#${patternId})` : cleanColor(finish.kind === 'paint' ? finish.color : undefined, DEFAULT_WALL_PAINT)
  const groutColor = cleanColor(tile?.groutColor, DEFAULT_GROUT_COLOR)
  const tileColor = cleanColor(tile?.tileColor, DEFAULT_TILE_COLOR)
  const tileW = Math.max(1, tile?.tileWIn ?? 12) / 12
  const tileH = Math.max(1, tile?.tileHIn ?? 24) / 12
  const grout = Math.max(0, tile?.groutIn ?? 0.125) / 12
  const currentWallKey = wallKey(wall)
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
        <span>{`${t('hub_sketch_dim_length_short')}: ${formatLength(lengthFt)}`}</span>
        <span>{`${t('hub_sketch_dim_height_short')}: ${formatLength(height)}`}</span>
        <span>{`${t('hub_sketch_3d_openings')}: ${openings.length}`}</span>
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
        <rect className="hub-sketch-elevation-wall" x={0} y={0} width={lengthFt} height={height} fill={fill} />
        <g className="hub-sketch-elevation-grid">
          {ticks(lengthFt, 0.5).map((x) => (
            <line key={`x${x}`} x1={x} y1={0} x2={x} y2={height} className={Math.abs(x - Math.round(x)) < 0.001 ? 'major' : undefined} />
          ))}
          {ticks(height, 0.5).map((y) => (
            <line key={`y${y}`} x1={0} y1={height - y} x2={lengthFt} y2={height - y} className={Math.abs(y - Math.round(y)) < 0.001 ? 'major' : undefined} />
          ))}
        </g>
        <rect className="hub-sketch-elevation-outline" x={0} y={0} width={lengthFt} height={height} />
        {openings.map((opening, index) => {
          const width = Math.min(openingWidthFt(opening), lengthFt)
          const openingHeight = Math.min(openingHeightFt(opening), height)
          const floor = Math.min(openingFloorFt(opening), Math.max(0, height - openingHeight))
          const x = Math.max(0, Math.min(lengthFt - width, opening.t * lengthFt - width / 2))
          const y = height - floor - openingHeight
          const label = opening.kind === 'door'
            ? `${formatLength(width)} x ${formatLength(openingHeight)}`
            : `${formatLength(width)} x ${formatLength(openingHeight)} / ${formatLength(floor)}`
          return (
            <g key={`${opening.kind}-${index}`}>
              <rect
                className={opening.kind === 'door' ? 'hub-sketch-elevation-door' : 'hub-sketch-elevation-window'}
                x={x}
                y={y}
                width={width}
                height={openingHeight}
              >
                <title>{label}</title>
              </rect>
              <text x={x + width / 2} y={Math.max(0.28, y - 0.14)} textAnchor="middle">
                {label}
              </text>
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
