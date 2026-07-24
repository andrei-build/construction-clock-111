import { createPortal } from 'react-dom'
import WallElevation from './WallElevation'
import { eachSegment } from './sketchOpeningGeometry'
import { normalizeFinishes, sketchWallKey } from './sketchFinishes'
import type { Sketch3DModel, SketchSurfaceFinish } from './sketchFinishes'
import type { SketchPlacedCatalogItem } from './sketchCatalog'
import { formatFeetInches, formatInches } from './inches'
import {
  CABINET_MATERIAL_SECTION,
  ELECTRICAL_MATERIAL_SECTION,
  TRIM_MATERIAL_SECTION,
  WALL_MATERIAL_SECTION,
  SKETCH_MATERIAL_SECTIONS,
  aggregateSketchMaterialRows,
  buildCabinetMaterialRows,
  buildElectricalMaterialRows,
  buildSketchContourStats,
  buildTrimMaterialRows,
  collectSketchMaterialFacts,
} from './sketchMaterials'
import type { SketchMaterialModel, SketchMaterialRow } from './sketchMaterials'
import { TILE_MATERIAL_SECTION } from './tileCalc'
import { SKETCH_LAYERS, LAYER_LABEL_KEYS } from '../../lib/sketchLayers'

// EXPORT-PACKAGE-46: печатный «пакет проекта» из эскиза — титул + план + развёртки стен + спецификация.
// Только ЧИТАЕТ модель эскиза (version:1 не трогаем), собирается из уже существующих кусков:
// renderPng(план) → <img>, WallElevation(развёртки), sketchMaterials.* (спецификация). window.print()
// печатает контейнер, скрытый на экране и раскрываемый через @media print (чёрным по белому).

const CELL_FT = 1
const DEFAULT_WALL_HEIGHT_FT = 8

type PrintModel = Sketch3DModel & { placedItems?: SketchPlacedCatalogItem[] }

// Метки для чистых сборщиков строк материалов (i18n прокидывается из SketchTab через t()).
export type SketchMaterialSpecLabels = {
  eachUnit?: string
  areaUnit?: string
  linearFtUnit?: string
  outletName?: string
  switchName?: string
  paintName?: string
  trimLang?: 'ru' | 'en' | 'es'
}

// Чистая функция сборки спецификации материалов из модели эскиза (юнит-тестируется отдельно).
// Плитка по зонам/стенам (площадь ft² + размер плитки) + краска стен + кабинеты/мебель с размерами
// + электрика + тримы. Всё считается из model, БЕЗ запросов к api/RPC (площади, не коробки).
export function buildSketchMaterialSpec(
  model: SketchMaterialModel,
  labels: SketchMaterialSpecLabels = {},
): SketchMaterialRow[] {
  const areaUnit = labels.areaUnit ?? 'ft²'
  const facts = collectSketchMaterialFacts(model)
  const rows: SketchMaterialRow[] = []
  facts.tileAreas.forEach((area) => {
    rows.push({
      section: TILE_MATERIAL_SECTION,
      name: area.label,
      qty: Math.round(area.areaSqft * 10) / 10,
      unit: areaUnit,
      note: `${formatInches(area.tileWIn)} × ${formatInches(area.tileHIn)}`,
    })
  })
  if (facts.paintAreaSqft > 0.05) {
    rows.push({
      section: WALL_MATERIAL_SECTION,
      name: labels.paintName ?? 'Paint',
      qty: Math.round(facts.paintAreaSqft * 10) / 10,
      unit: areaUnit,
      note: null,
    })
  }
  rows.push(...buildCabinetMaterialRows(model, labels))
  rows.push(...buildElectricalMaterialRows(model, labels))
  rows.push(...buildTrimMaterialRows(model, { labels }))
  return aggregateSketchMaterialRows(rows)
}

function modelCellFt(model: PrintModel): number {
  return Number.isFinite(model.cellFt) && model.cellFt > 0 ? model.cellFt : CELL_FT
}

function wallHeightFt(model: PrintModel): number {
  return Number.isFinite(model.height) && (model.height ?? 0) > 0 ? model.height ?? DEFAULT_WALL_HEIGHT_FT : DEFAULT_WALL_HEIGHT_FT
}

function segmentLengthFt(a: { x: number; y: number }, b: { x: number; y: number }, cellFt: number): number {
  return Math.hypot(a.x - b.x, a.y - b.y) * cellFt
}

function fmtQty(value: number | null): string {
  if (value == null) return '—'
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '')
}

export type SketchPrintPackageProps = {
  model: PrintModel
  projectName: string
  projectAddress: string | null
  sketchName: string
  dateText: string
  planImageUrl: string | null
  blueprintDimensionsEnabled?: boolean
  t: (key: string) => string
}

export default function SketchPrintPackage({
  model,
  projectName,
  projectAddress,
  sketchName,
  dateText,
  planImageUrl,
  blueprintDimensionsEnabled = false,
  t,
}: SketchPrintPackageProps) {
  if (typeof document === 'undefined') return null

  const cellFt = modelCellFt(model)
  const heightFt = wallHeightFt(model)
  const finishes = normalizeFinishes(model.finishes)
  const walls = eachSegment(model)
  const stats = buildSketchContourStats(model)
  const spec = buildSketchMaterialSpec(model, {
    eachUnit: t('hub_sketch_print_unit_each'),
    areaUnit: t('hub_sketch_print_unit_area'),
    linearFtUnit: t('hub_sketch_print_unit_lnft'),
    outletName: t('hub_sketch_print_outlet'),
    switchName: t('hub_sketch_print_switch'),
    paintName: t('hub_sketch_print_paint'),
    trimLang: 'en',
  })

  const sectionLabel = (section: SketchMaterialRow['section']): string => {
    if (section === TILE_MATERIAL_SECTION) return t('hub_sketch_material_section_tile')
    if (section === WALL_MATERIAL_SECTION) return t('hub_sketch_material_section_walls')
    if (section === TRIM_MATERIAL_SECTION) return t('hub_sketch_material_section_trim')
    if (section === CABINET_MATERIAL_SECTION) return t('hub_sketch_material_section_cabinets')
    if (section === ELECTRICAL_MATERIAL_SECTION) return t('hub_sketch_material_section_electrical')
    return section
  }

  const scaleText = `${t('hub_sketch_print_scale')}: 1 = ${formatFeetInches(cellFt * 12)}`

  const node = (
    <div className="sketch-print-portal">
      <div className="sketch-print-package" role="document">
        {/* 1) Титульный лист */}
        <section className="sketch-print-section sketch-print-cover">
          <div className="sketch-print-brand">{t('appName')}</div>
          <h1 className="sketch-print-title">{projectName || sketchName || t('hub_sketch_print_untitled')}</h1>
          {projectAddress && <div className="sketch-print-address">{projectAddress}</div>}
          <div className="sketch-print-meta">
            <div><span>{t('hub_sketch_print_project')}:</span> {projectName || t('hub_sketch_print_untitled')}</div>
            {projectAddress && <div><span>{t('hub_sketch_print_address')}:</span> {projectAddress}</div>}
            <div><span>{t('hub_sketch_print_sketch')}:</span> {sketchName || '—'}</div>
            <div><span>{t('hub_sketch_print_date')}:</span> {dateText}</div>
          </div>
        </section>

        {/* 2) План с размерами */}
        <section className="sketch-print-section sketch-print-plan" data-blueprint-dims={blueprintDimensionsEnabled ? 'on' : 'off'}>
          <h2>{t('hub_sketch_print_plan')}</h2>
          {planImageUrl ? (
            <img className="sketch-print-plan-image" src={planImageUrl} alt={t('hub_sketch_print_plan')} />
          ) : (
            <div className="sketch-print-empty">—</div>
          )}
          <div className="sketch-print-plan-scale">{scaleText}</div>
          <div className="sketch-print-plan-stats">
            {`${t('hub_sketch_area')}: ${stats.totalArea.toFixed(1)} ft²  ·  ${t('hub_sketch_perimeter')}: ${formatFeetInches(stats.totalPerimeter * 12)}`}
          </div>
          {/* BLUEPRINT-LAYERS-59: легенда слоёв на листе — чёрным по белому (штриховка/пунктир,
              печать не полагается на цвет). Образцы совпадают со штриховкой плана. */}
          <div className="sketch-print-legend" aria-label={t('hub_sketch_layer_legend')}>
            {SKETCH_LAYERS.map((layer) => (
              <span className="sketch-print-legend-row" key={layer}>
                <span className={`sketch-print-legend-swatch sketch-print-legend-swatch-${layer}`} aria-hidden="true" />
                <span>{t(LAYER_LABEL_KEYS[layer])}</span>
              </span>
            ))}
          </div>
        </section>

        {/* 3) Развёртка каждой стены */}
        {walls.map((wall) => {
          const key = sketchWallKey(wall.c, wall.s)
          const surface: SketchSurfaceFinish = finishes.wallFinishes[key] ?? finishes.walls
          const lengthFt = segmentLengthFt(wall.a, wall.b, cellFt)
          return (
            <section className="sketch-print-section sketch-print-elevation" key={key}>
              <h2>
                {`${t('hub_sketch_print_wall')} ${wall.c + 1}.${wall.s + 1}`}
                <span className="sketch-print-elevation-len">{` · ${formatFeetInches(lengthFt * 12)}`}</span>
              </h2>
              <div className="sketch-print-elevation-frame">
                <WallElevation
                  model={model}
                  wall={wall}
                  heightFt={heightFt}
                  finish={surface}
                  compact
                  codeCheckEnabled={false}
                />
              </div>
            </section>
          )
        })}

        {/* 4) Спецификация материалов */}
        <section className="sketch-print-section sketch-print-materials">
          <h2>{t('hub_sketch_print_materials')}</h2>
          {spec.length === 0 ? (
            <div className="sketch-print-empty">—</div>
          ) : (
            <table className="sketch-print-table">
              <thead>
                <tr>
                  <th>{t('hub_sketch_print_col_section')}</th>
                  <th>{t('mat_col_name')}</th>
                  <th>{t('mat_col_qty')}</th>
                  <th>{t('mat_col_unit')}</th>
                  <th>{t('mat_col_note')}</th>
                </tr>
              </thead>
              <tbody>
                {SKETCH_MATERIAL_SECTIONS.flatMap((section) =>
                  spec
                    .filter((row) => row.section === section)
                    .map((row, index) => (
                      <tr key={`${section}-${row.name}-${index}`}>
                        <td>{sectionLabel(section)}</td>
                        <td>{row.name}</td>
                        <td>{fmtQty(row.qty)}</td>
                        <td>{row.unit ?? '—'}</td>
                        <td>{row.note ?? '—'}</td>
                      </tr>
                    )),
                )}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  )

  return createPortal(node, document.body)
}
