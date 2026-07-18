import { useMemo } from 'react'
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
  type SketchSurfaceFinish,
} from './sketchFinishes'
import { formatFeetInches } from './inches'

const CELL_FT = 1
const DOOR_W_FT = 3
const DOOR_H_FT = 6.8
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
  return opening.kind === 'door' ? DOOR_H_FT : (opening.h ?? WIN_H_FT)
}

function openingFloorFt(opening: Opening): number {
  return opening.kind === 'door' ? 0 : (opening.sill ?? WIN_SILL_FT)
}

function formatLength(valueFt: number): string {
  return formatFeetInches((Number.isFinite(valueFt) ? valueFt : 0) * 12)
}

function ticks(max: number, step: number): number[] {
  const count = Math.min(240, Math.floor(max / step) + 1)
  return Array.from({ length: count }, (_, index) => index * step).filter((value) => value <= max + 0.0001)
}

export default function WallElevation({ model, wall, heightFt, finish }: WallElevationProps) {
  const { t } = useI18n()
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

  return (
    <div className="hub-sketch-elevation">
      <div className="hub-sketch-elevation-meta">
        <span>{`${t('hub_sketch_dim_length_short')}: ${formatLength(lengthFt)}`}</span>
        <span>{`${t('hub_sketch_dim_height_short')}: ${formatLength(height)}`}</span>
        <span>{`${t('hub_sketch_3d_openings')}: ${openings.length}`}</span>
      </div>
      <svg className="hub-sketch-elevation-svg" viewBox={viewBox} role="img" aria-label={t('hub_sketch_3d_wall_elevation')}>
        <defs>
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
      </svg>
    </div>
  )
}
