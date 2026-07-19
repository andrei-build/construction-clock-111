import { useEffect, useMemo, useState } from 'react'
import { useI18n } from '../../lib/i18n'
import VoiceMic from '../../components/VoiceMic'
import {
  bulkInsertProjectMaterials,
  createDeliveryFromProjectMaterials,
  getCatalogItems,
  getProjectMaterialTasks,
  getProjectMaterials,
  requestProjectMaterial,
  softDeleteProjectMaterial,
  subscribeToTaskChanges,
  updateProjectMaterial,
  updateProjectMaterialNeededBy,
  type CatalogItem,
  type ProjectMaterialInput,
} from '../../lib/api'
import { isManagerWrite } from '../../lib/types'
import type { MaterialSpecStatus, ProjectMaterial, Profile, Project, Task } from '../../lib/types'
import { formatInches, parseInches } from './inches'
import {
  TILE_CALC_PATTERNS,
  appendTileCalcMaterials,
  calculateTileMaterials,
  type TileCalcPattern,
  type TileCalcResult,
} from './tileCalc'

interface MaterialsTabProps {
  project: Project
  profile: Profile | null
}

// Черновик строки формы/редактирования — все поля строками, конвертим при сохранении.
interface DraftRow {
  section: string
  name: string
  qty: string
  unit: string
  supplier: string
  url: string
  note: string
}

const blankDraft = (): DraftRow => ({ section: '', name: '', qty: '', unit: '', supplier: '', url: '', note: '' })

function draftToInput(d: DraftRow): ProjectMaterialInput {
  const q = d.qty.trim() ? Number(d.qty.trim().replace(',', '.')) : null
  return {
    section: d.section.trim() || null,
    name: d.name.trim(),
    qty: q != null && !Number.isNaN(q) ? q : null,
    unit: d.unit.trim() || null,
    supplier: d.supplier.trim() || null,
    url: d.url.trim() || null,
    note: d.note.trim() || null,
  }
}

function materialToDraft(m: ProjectMaterial): DraftRow {
  return {
    section: m.section ?? '',
    name: m.name,
    qty: m.qty != null ? String(m.qty) : '',
    unit: m.unit ?? '',
    supplier: m.supplier ?? '',
    url: m.url ?? '',
    note: m.note ?? '',
  }
}

// Простой парсер вставки/файла: Excel-clipboard = TSV; .csv = запятые. Определяем разделитель
// по наличию табов. Колонки по порядку: name, qty, unit, supplier, url, note. БЕЗ тяжёлых зависимостей.
function parseDelimited(text: string): ProjectMaterialInput[] {
  const delim = text.includes('\t') ? '\t' : ','
  const rows: ProjectMaterialInput[] = []
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue
    const cols = raw.split(delim)
    const name = (cols[0] ?? '').trim()
    if (!name) continue
    const qtyRaw = (cols[1] ?? '').trim()
    const q = qtyRaw ? Number(qtyRaw.replace(',', '.')) : null
    rows.push({
      name,
      qty: q != null && !Number.isNaN(q) ? q : null,
      unit: (cols[2] ?? '').trim() || null,
      supplier: (cols[3] ?? '').trim() || null,
      url: (cols[4] ?? '').trim() || null,
      note: (cols[5] ?? '').trim() || null,
    })
  }
  return rows
}

// CSV-экранирование одного поля: кавычим, если есть запятая/кавычка/перенос строки (RFC 4180).
function csvEscape(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

// Живой статус позиции: связанная задача (task_id) — источник правды забора/доставки (MAT-1).
function derivedStatus(m: ProjectMaterial, taskById: Map<string, Task>): MaterialSpecStatus {
  if (!m.task_id) return m.status === 'requested' ? 'requested' : 'plan'
  const task = taskById.get(m.task_id)
  if (!task) return m.status
  if (task.status === 'cancelled') return 'plan'
  if (task.delivered_at) return 'delivered'
  if (task.picked_up_at) return 'picked_up'
  return 'requested'
}

const STATUS_LABEL: Record<MaterialSpecStatus, string> = {
  plan: 'mat_status_plan',
  requested: 'mat_status_requested',
  picked_up: 'mat_status_picked_up',
  delivered: 'mat_status_delivered',
}
const STATUS_BADGE: Record<MaterialSpecStatus, string> = {
  plan: 'badge grey',
  requested: 'badge amber',
  picked_up: 'badge blue',
  delivered: 'badge green',
}

type AreaMode = 'area' | 'dims'

const DEFAULT_TILE_W_IN = 12
const DEFAULT_TILE_H_IN = 24
const DEFAULT_JOINT_IN = 0.125
const DEFAULT_THICKNESS_IN = 0.3125
const MIN_JOINT_IN = 1 / 16
const MAX_JOINT_IN = 1 / 4

function parseDecimalInput(value: string): number | null {
  const n = Number(value.trim().replace(',', '.'))
  return value.trim() && Number.isFinite(n) ? n : null
}

function optionalPositive(value: string): number | null {
  const n = parseDecimalInput(value)
  return n != null && n > 0 ? n : null
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function parseInchOrFallback(value: string, fallback: number, min = 0): number {
  const parsed = parseInches(value)
  return Number.isFinite(parsed) && parsed > min ? parsed : fallback
}

function fmtQty(value: number | null): string {
  if (value == null) return '—'
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '')
}

function TileCalculator({
  project,
  profile,
  onAdded,
}: {
  project: Project
  profile: Profile | null
  onAdded: (rows: ProjectMaterial[]) => void
}) {
  const { t, lang } = useI18n()
  const [areaMode, setAreaMode] = useState<AreaMode>('area')
  const [areaSqft, setAreaSqft] = useState('120')
  const [lengthFt, setLengthFt] = useState('')
  const [widthFt, setWidthFt] = useState('')
  const [tileW, setTileW] = useState(formatInches(DEFAULT_TILE_W_IN))
  const [tileH, setTileH] = useState(formatInches(DEFAULT_TILE_H_IN))
  const [joint, setJoint] = useState(formatInches(DEFAULT_JOINT_IN))
  const [thickness, setThickness] = useState(formatInches(DEFAULT_THICKNESS_IN))
  const [pattern, setPattern] = useState<TileCalcPattern>('straight')
  const [boxSqft, setBoxSqft] = useState('15.5')
  const [pricePerBox, setPricePerBox] = useState('45')
  const [catalogItemId, setCatalogItemId] = useState('')
  const [perimeterLnft, setPerimeterLnft] = useState('')
  const [includeSubstrate, setIncludeSubstrate] = useState(false)
  const [includeWaterproofing, setIncludeWaterproofing] = useState(false)
  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([])
  const [result, setResult] = useState<TileCalcResult | null>(null)
  const [calcBusy, setCalcBusy] = useState(false)
  const [appendBusy, setAppendBusy] = useState(false)
  const [calcError, setCalcError] = useState<string | null>(null)
  const [appendNotice, setAppendNotice] = useState<number | null>(null)

  useEffect(() => {
    let mounted = true
    getCatalogItems()
      .then((rows) => {
        if (mounted) setCatalogItems(rows.filter((item) => item.is_active))
      })
      .catch(() => { if (mounted) setCatalogItems([]) })
    return () => { mounted = false }
  }, [])

  const computedArea = useMemo(() => {
    if (areaMode === 'area') return optionalPositive(areaSqft)
    const length = optionalPositive(lengthFt)
    const width = optionalPositive(widthFt)
    return length != null && width != null ? length * width : null
  }, [areaMode, areaSqft, lengthFt, widthFt])

  const priceFmt = useMemo(
    () => new Intl.NumberFormat(lang === 'ru' ? 'ru-RU' : lang === 'es' ? 'es-ES' : 'en-US', {
      style: 'currency', currency: 'USD', maximumFractionDigits: 2,
    }),
    [lang],
  )

  const normalizeInchField = (
    value: string,
    setter: (value: string) => void,
    fallback: number,
    min = 0,
    max: number | null = null,
  ) => {
    const parsed = parseInchOrFallback(value, fallback, min)
    setter(formatInches(max != null ? clamp(parsed, min, max) : parsed))
  }

  const runCalc = async () => {
    if (calcBusy) return
    const area = computedArea
    if (area == null || area <= 0) { setCalcError('tile_calc_area_required'); return }
    const tileWIn = parseInchOrFallback(tileW, DEFAULT_TILE_W_IN)
    const tileHIn = parseInchOrFallback(tileH, DEFAULT_TILE_H_IN)
    const jointIn = clamp(parseInchOrFallback(joint, DEFAULT_JOINT_IN, 0), MIN_JOINT_IN, MAX_JOINT_IN)
    const tileThicknessIn = parseInchOrFallback(thickness, DEFAULT_THICKNESS_IN)
    const box = optionalPositive(boxSqft)
    const price = catalogItemId ? null : optionalPositive(pricePerBox)
    const perimeter = optionalPositive(perimeterLnft)
    setCalcBusy(true)
    setCalcError(null)
    setAppendNotice(null)
    try {
      const data = await calculateTileMaterials({
        areaSqft: area,
        tileWIn,
        tileHIn,
        jointIn,
        tileThicknessIn,
        pattern,
        boxSqft: box,
        pricePerBox: price,
        catalogItemId: catalogItemId || null,
        perimeterLnft: perimeter,
        includeSubstrate,
        includeWaterproofing,
      })
      setTileW(formatInches(tileWIn))
      setTileH(formatInches(tileHIn))
      setJoint(formatInches(jointIn))
      setThickness(formatInches(tileThicknessIn))
      setResult(data)
    } catch {
      setCalcError('tile_calc_failed')
    } finally {
      setCalcBusy(false)
    }
  }

  const appendResult = async () => {
    if (!profile || !result || appendBusy) return
    setAppendBusy(true)
    setCalcError(null)
    setAppendNotice(null)
    try {
      const created = await appendTileCalcMaterials(profile, project.id, result.items)
      onAdded(created)
      setAppendNotice(created.length)
    } catch {
      setCalcError('tile_calc_append_failed')
    } finally {
      setAppendBusy(false)
    }
  }

  const patternLabel = (value: TileCalcPattern) => t(`tile_calc_pattern_${value}`)

  return (
    <details className="card tile-calc-card">
      <summary className="tile-calc-summary">
        <span>
          <strong>{t('tile_calc_title')}</strong>
          <span className="muted">{t('tile_calc_subtitle')}</span>
        </span>
        {result && <span className={result.norms_source === 'org' ? 'badge green' : 'badge amber'}>{result.norms_source === 'org' ? t('tile_calc_norms_org') : t('tile_calc_norms_industry')}</span>}
      </summary>

      <div className="tile-calc-body">
        <div className="tile-calc-mode" role="group" aria-label={t('tile_calc_area')}>
          <button type="button" className={areaMode === 'area' ? 'active' : ''} onClick={() => setAreaMode('area')}>{t('tile_calc_area_sqft')}</button>
          <button type="button" className={areaMode === 'dims' ? 'active' : ''} onClick={() => setAreaMode('dims')}>{t('tile_calc_area_dims')}</button>
        </div>

        <div className="tile-calc-grid">
          {areaMode === 'area' ? (
            <label>
              <span>{t('tile_calc_area_sqft')}</span>
              <input inputMode="decimal" value={areaSqft} onChange={(e) => setAreaSqft(e.target.value)} />
            </label>
          ) : (
            <>
              <label>
                <span>{t('tile_calc_length_ft')}</span>
                <input inputMode="decimal" value={lengthFt} onChange={(e) => setLengthFt(e.target.value)} />
              </label>
              <label>
                <span>{t('tile_calc_width_ft')}</span>
                <input inputMode="decimal" value={widthFt} onChange={(e) => setWidthFt(e.target.value)} />
              </label>
            </>
          )}
          <label>
            <span>{t('tile_calc_tile_w')}</span>
            <input value={tileW} onBlur={() => normalizeInchField(tileW, setTileW, DEFAULT_TILE_W_IN)} onChange={(e) => setTileW(e.target.value)} />
          </label>
          <label>
            <span>{t('tile_calc_tile_h')}</span>
            <input value={tileH} onBlur={() => normalizeInchField(tileH, setTileH, DEFAULT_TILE_H_IN)} onChange={(e) => setTileH(e.target.value)} />
          </label>
          <label>
            <span>{t('tile_calc_joint')}</span>
            <input value={joint} onBlur={() => normalizeInchField(joint, setJoint, DEFAULT_JOINT_IN, MIN_JOINT_IN, MAX_JOINT_IN)} onChange={(e) => setJoint(e.target.value)} />
          </label>
          <label>
            <span>{t('tile_calc_thickness')}</span>
            <input value={thickness} onBlur={() => normalizeInchField(thickness, setThickness, DEFAULT_THICKNESS_IN)} onChange={(e) => setThickness(e.target.value)} />
          </label>
          <label>
            <span>{t('tile_calc_pattern')}</span>
            <select value={pattern} onChange={(e) => setPattern(e.target.value as TileCalcPattern)}>
              {TILE_CALC_PATTERNS.map((p) => <option key={p} value={p}>{patternLabel(p)}</option>)}
            </select>
          </label>
          <label>
            <span>{t('tile_calc_box_sqft')}</span>
            <input inputMode="decimal" value={boxSqft} onChange={(e) => setBoxSqft(e.target.value)} />
          </label>
          <label>
            <span>{t('tile_calc_catalog_item')}</span>
            <select value={catalogItemId} onChange={(e) => setCatalogItemId(e.target.value)}>
              <option value="">{t('tile_calc_catalog_none')}</option>
              {catalogItems.map((item) => (
                <option key={item.id} value={item.id}>{[item.name, item.brand, item.model].filter(Boolean).join(' · ')}</option>
              ))}
            </select>
          </label>
          <label>
            <span>{t('tile_calc_price_box')}</span>
            <input inputMode="decimal" value={pricePerBox} disabled={!!catalogItemId} onChange={(e) => setPricePerBox(e.target.value)} />
          </label>
          <label>
            <span>{t('tile_calc_perimeter')}</span>
            <input inputMode="decimal" value={perimeterLnft} onChange={(e) => setPerimeterLnft(e.target.value)} />
          </label>
        </div>

        <div className="tile-calc-options">
          <label>
            <input type="checkbox" checked={includeSubstrate} onChange={(e) => setIncludeSubstrate(e.target.checked)} />
            <span>{t('tile_calc_include_substrate')}</span>
          </label>
          <label>
            <input type="checkbox" checked={includeWaterproofing} onChange={(e) => setIncludeWaterproofing(e.target.checked)} />
            <span>{t('tile_calc_include_waterproofing')}</span>
          </label>
          {computedArea != null && <span className="badge blue">{t('tile_calc_area')}: {fmtQty(computedArea)} sqft</span>}
        </div>

        <div className="row tile-calc-actions">
          <button className="btn small" type="button" disabled={calcBusy} onClick={runCalc}>{calcBusy ? t('loading') : t('tile_calc_run')}</button>
          <button className="btn ghost small" type="button" disabled={!result || appendBusy} onClick={appendResult}>{appendBusy ? t('saving') : t('tile_calc_add_to_spec')}</button>
        </div>

        {calcError && <p className="error-msg">{t(calcError)}</p>}
        {appendNotice != null && <p className="ok-msg">{t('tile_calc_added')}: {appendNotice}</p>}

        {result && (
          <div className="tile-calc-results">
            <div className="tile-calc-result-head">
              <span>{t('mat_col_name')}</span>
              <span>{t('mat_col_qty')}</span>
              <span>{t('mat_col_unit')}</span>
              <span>{t('tile_calc_price')}</span>
              <span>{t('total')}</span>
            </div>
            {result.items.map((item) => (
              <div className="tile-calc-result-row" key={item.key}>
                <span>
                  <strong>{item.name}</strong>
                  {item.detail && <small>{item.detail}</small>}
                </span>
                <span>{fmtQty(item.qty)}</span>
                <span>{item.unit ?? '—'}</span>
                <span>{item.price != null ? priceFmt.format(item.price) : '—'}</span>
                <span>{item.total != null ? priceFmt.format(item.total) : '—'}</span>
              </div>
            ))}
            <div className="tile-calc-total">
              <span className={result.norms_source === 'org' ? 'badge green' : 'badge amber'}>{result.norms_source === 'org' ? t('tile_calc_norms_org') : t('tile_calc_norms_industry')}</span>
              <strong>{t('tile_calc_known_total')}: {result.totals.known_total != null ? priceFmt.format(result.totals.known_total) : '—'}</strong>
              {!result.totals.complete && <span className="muted">{t('tile_calc_total_incomplete')}</span>}
            </div>
          </div>
        )}
      </div>
    </details>
  )
}

export default function MaterialsTab({ project, profile }: MaterialsTabProps) {
  const { t, lang } = useI18n()
  const [materials, setMaterials] = useState<ProjectMaterial[]>([])
  const [taskById, setTaskById] = useState<Map<string, Task>>(new Map())
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [drafts, setDrafts] = useState<DraftRow[]>([blankDraft()])
  const [importText, setImportText] = useState('')
  const [importNotice, setImportNotice] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [rowBusy, setRowBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editId, setEditId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<DraftRow>(blankDraft())
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [deliveryBusy, setDeliveryBusy] = useState(false)
  const [deliveryNotice, setDeliveryNotice] = useState<number | null>(null)
  const canManage = profile ? isManagerWrite(profile.role) : false

  useEffect(() => {
    let mounted = true
    ;(async () => {
      setLoading(true)
      setLoadError(false)
      try {
        const [rows, tasks] = await Promise.all([
          getProjectMaterials(project.id),
          getProjectMaterialTasks(project.id),
        ])
        if (!mounted) return
        setMaterials(rows)
        setTaskById(new Map(tasks.map((tk) => [tk.id, tk])))
      } catch {
        if (mounted) setLoadError(true)
      } finally {
        if (mounted) setLoading(false)
      }
    })()
    return () => { mounted = false }
  }, [project.id])

  // Реалтайм по задачам: живой статус позиций (забор/доставка ставит MAT-1, не спецификация).
  useEffect(() => {
    if (!profile?.org_id) return
    const refreshTasks = async () => {
      const tasks = await getProjectMaterialTasks(project.id)
      setTaskById(new Map(tasks.map((tk) => [tk.id, tk])))
    }
    return subscribeToTaskChanges(profile.org_id, () => { void refreshTasks() }, `mat-spec:${project.id}`)
  }, [profile?.org_id, project.id])

  // Секции в порядке первого появления — для группировки списка.
  const sections = useMemo(() => {
    const seen = new Set<string>()
    const order: string[] = []
    for (const m of materials) {
      const key = m.section ?? ''
      if (!seen.has(key)) { seen.add(key); order.push(key) }
    }
    return order
  }, [materials])

  const selectableMaterials = useMemo(
    () => materials.filter((m) => derivedStatus(m, taskById) === 'plan'),
    [materials, taskById],
  )

  const selectedMaterials = useMemo(
    () => selectableMaterials.filter((m) => selectedIds.has(m.id)),
    [selectableMaterials, selectedIds],
  )

  useEffect(() => {
    setSelectedIds((current) => {
      const allowed = new Set(selectableMaterials.map((m) => m.id))
      const next = new Set([...current].filter((id) => allowed.has(id)))
      return next.size === current.size ? current : next
    })
  }, [selectableMaterials])

  const updateDraft = (idx: number, patch: Partial<DraftRow>) => {
    setDrafts((rows) => rows.map((row, i) => (i === idx ? { ...row, ...patch } : row)))
  }

  const addDraftRow = () => setDrafts((rows) => [...rows, blankDraft()])
  const removeDraftRow = (idx: number) => setDrafts((rows) => (rows.length > 1 ? rows.filter((_, i) => i !== idx) : rows))

  const saveNewRows = async () => {
    if (!profile || busy) return
    const inputs = drafts.map(draftToInput).filter((r) => r.name.trim())
    if (inputs.length === 0) { setError('mat_need_name'); return }
    setBusy(true)
    setError(null)
    try {
      const created = await bulkInsertProjectMaterials(profile, project.id, inputs)
      setMaterials((rows) => [...rows, ...created])
      setDrafts([blankDraft()])
    } catch {
      setError('mat_save_failed')
    } finally {
      setBusy(false)
    }
  }

  const runImport = async () => {
    if (!profile || busy) return
    const inputs = parseDelimited(importText)
    if (inputs.length === 0) { setError('mat_import_empty'); return }
    setBusy(true)
    setError(null)
    setImportNotice(null)
    try {
      const created = await bulkInsertProjectMaterials(profile, project.id, inputs)
      setMaterials((rows) => [...rows, ...created])
      setImportText('')
      setImportNotice(created.length)
    } catch {
      setError('mat_import_failed')
    } finally {
      setBusy(false)
    }
  }

  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const text = await file.text()
      setImportText((prev) => (prev ? `${prev}\n${text}` : text))
    } catch {
      setError('mat_import_failed')
    }
  }

  const requestRow = async (m: ProjectMaterial) => {
    if (!profile || rowBusy) return
    setRowBusy(m.id)
    setError(null)
    try {
      const updated = await requestProjectMaterial(profile, m)
      setMaterials((rows) => rows.map((r) => (r.id === m.id ? updated : r)))
    } catch {
      setError('mat_request_failed')
    } finally {
      setRowBusy(null)
    }
  }

  const startEdit = (m: ProjectMaterial) => {
    setEditId(m.id)
    setEditDraft(materialToDraft(m))
    setError(null)
  }

  const saveEdit = async () => {
    if (!profile || !editId || rowBusy) return
    const input = draftToInput(editDraft)
    if (!input.name.trim()) { setError('mat_need_name'); return }
    setRowBusy(editId)
    setError(null)
    try {
      const updated = await updateProjectMaterial(profile, editId, input)
      setMaterials((rows) => rows.map((r) => (r.id === editId ? updated : r)))
      setEditId(null)
    } catch {
      setError('mat_save_failed')
    } finally {
      setRowBusy(null)
    }
  }

  const deleteRow = async (m: ProjectMaterial) => {
    if (!profile || rowBusy) return
    setRowBusy(m.id)
    setError(null)
    try {
      await softDeleteProjectMaterial(profile, m.id)
      setMaterials((rows) => rows.filter((r) => r.id !== m.id))
      setConfirmDeleteId(null)
    } catch {
      setError('mat_delete_failed')
    } finally {
      setRowBusy(null)
    }
  }

  const saveNeededBy = async (m: ProjectMaterial, value: string) => {
    if (!profile || rowBusy) return
    setRowBusy(m.id)
    setError(null)
    setDeliveryNotice(null)
    try {
      const updated = await updateProjectMaterialNeededBy(profile, m.id, value || null)
      setMaterials((rows) => rows.map((r) => (r.id === m.id ? updated : r)))
    } catch {
      setError('mat_needed_by_failed')
    } finally {
      setRowBusy(null)
    }
  }

  const toggleSelection = (id: string, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const toggleSelectAll = (checked: boolean) => {
    setSelectedIds(checked ? new Set(selectableMaterials.map((m) => m.id)) : new Set())
  }

  const createDelivery = async () => {
    if (!profile || deliveryBusy) return
    if (selectedMaterials.length === 0) {
      setError('mat_delivery_select_empty')
      return
    }
    setDeliveryBusy(true)
    setError(null)
    setDeliveryNotice(null)
    try {
      const projectLabel = project.name || project.id
      const result = await createDeliveryFromProjectMaterials(profile, {
        projectId: project.id,
        title: t('mat_delivery_task_title').replace('{project}', projectLabel),
        description: t('mat_delivery_task_desc').replace('{n}', String(selectedMaterials.length)),
        materials: selectedMaterials,
      })
      const updatedById = new Map(result.materials.map((m) => [m.id, m]))
      setMaterials((rows) => rows.map((row) => updatedById.get(row.id) ?? row))
      setSelectedIds(new Set())
      setDeliveryNotice(result.items.length)
      const tasks = await getProjectMaterialTasks(project.id)
      setTaskById(new Map(tasks.map((tk) => [tk.id, tk])))
    } catch {
      setError('mat_delivery_failed')
    } finally {
      setDeliveryBusy(false)
    }
  }

  // MAT-4-мини: экспорт спецификации в CSV-файл (без тяжёлых зависимостей). Читаемый для Excel
  // (BOM + заголовок), колонки как у импорта плюс секция. Доступен любому, кто видит вкладку.
  const exportSpec = () => {
    const header = ['Section', 'Name', 'Qty', 'Unit', 'Needed by', 'Supplier', 'URL', 'Note']
    const rows = materials.map((m) => [
      m.section ?? '',
      m.name,
      m.qty != null ? String(m.qty) : '',
      m.unit ?? '',
      m.needed_by ?? '',
      m.supplier ?? '',
      m.url ?? '',
      m.note ?? '',
    ])
    const csv = [header, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `materials-${(project.name ?? project.id)}.csv`.replace(/[^\w.-]+/g, '_')
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const renderRow = (m: ProjectMaterial) => {
    const status = derivedStatus(m, taskById)
    const isEditing = editId === m.id
    if (isEditing && canManage) {
      return (
        <div className="card material-row editing" key={m.id}>
          <div className="material-edit-grid">
            <input value={editDraft.section} onChange={(e) => setEditDraft((d) => ({ ...d, section: e.target.value }))} placeholder={t('mat_col_section')} />
            <div className="material-name-cell">
              <input value={editDraft.name} onChange={(e) => setEditDraft((d) => ({ ...d, name: e.target.value }))} placeholder={t('mat_col_name')} />
              <VoiceMic lang={lang} title={t('mat_voice_hint')} onResult={(text) => setEditDraft((d) => ({ ...d, name: d.name ? `${d.name} ${text}` : text }))} />
            </div>
            <input className="material-qty" inputMode="decimal" value={editDraft.qty} onChange={(e) => setEditDraft((d) => ({ ...d, qty: e.target.value }))} placeholder={t('mat_col_qty')} />
            <input value={editDraft.unit} onChange={(e) => setEditDraft((d) => ({ ...d, unit: e.target.value }))} placeholder={t('mat_col_unit')} />
            <input value={editDraft.supplier} onChange={(e) => setEditDraft((d) => ({ ...d, supplier: e.target.value }))} placeholder={t('mat_col_supplier')} />
            <input value={editDraft.url} onChange={(e) => setEditDraft((d) => ({ ...d, url: e.target.value }))} placeholder={t('mat_col_url')} />
            <input value={editDraft.note} onChange={(e) => setEditDraft((d) => ({ ...d, note: e.target.value }))} placeholder={t('mat_col_note')} />
          </div>
          <div className="row material-row-actions">
            <button className="btn small" type="button" disabled={rowBusy === m.id} onClick={saveEdit}>{rowBusy === m.id ? t('saving') : t('mat_save_edit')}</button>
            <button className="btn ghost small" type="button" disabled={rowBusy === m.id} onClick={() => setEditId(null)}>{t('cancel')}</button>
          </div>
        </div>
      )
    }
    return (
      <div className="card material-row" key={m.id}>
        {canManage && (
          <label className="material-row-check" aria-label={t('mat_to_delivery')}>
            <input
              type="checkbox"
              checked={selectedIds.has(m.id)}
              disabled={status !== 'plan' || deliveryBusy}
              onChange={(e) => toggleSelection(m.id, e.target.checked)}
            />
          </label>
        )}
        <div className="material-row-main">
          <div className="material-row-title">
            <span className="item-title">{m.name}</span>
            {(m.qty != null || m.unit) && <span className="muted"> · {m.qty ?? ''}{m.unit ? ` ${m.unit}` : ''}</span>}
            <span className={STATUS_BADGE[status]}>{t(STATUS_LABEL[status])}</span>
          </div>
          <div className="material-row-meta muted">
            {m.supplier && <span>{m.supplier}</span>}
            {m.url && <a href={m.url} target="_blank" rel="noreferrer" className="inline-link">{t('mat_open_link')}</a>}
            {m.note && <span>{m.note}</span>}
          </div>
        </div>
        {(canManage || m.needed_by) && (
          <div className="material-row-needed">
            {canManage ? (
              <label>
                <span>{t('mat_col_needed_by')}</span>
                <input
                  type="date"
                  value={m.needed_by ?? ''}
                  disabled={rowBusy === m.id}
                  onChange={(e) => { void saveNeededBy(m, e.target.value) }}
                />
              </label>
            ) : (
              <span className="badge grey">{`${t('mat_col_needed_by')}: ${m.needed_by}`}</span>
            )}
          </div>
        )}
        {canManage && (
          <div className="row material-row-actions">
            {status === 'plan' && (
              <button className="btn small" type="button" disabled={rowBusy === m.id} onClick={() => requestRow(m)}>
                {rowBusy === m.id ? t('saving') : t('mat_to_request')}
              </button>
            )}
            <button className="btn ghost small" type="button" disabled={rowBusy === m.id} onClick={() => startEdit(m)}>{t('mat_edit')}</button>
            {confirmDeleteId !== m.id && (
              <button className="btn ghost small" type="button" disabled={rowBusy === m.id} onClick={() => setConfirmDeleteId(m.id)}>{t('mat_delete')}</button>
            )}
            {confirmDeleteId === m.id && (
              <>
                <button className="btn red small" type="button" disabled={rowBusy === m.id} onClick={() => deleteRow(m)}>{t('mat_delete_confirm_yes')}</button>
                <button className="btn ghost small" type="button" disabled={rowBusy === m.id} onClick={() => setConfirmDeleteId(null)}>{t('cancel')}</button>
              </>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <section className="hub-tab-panel hub-materials">
      {canManage && (
        <>
          <TileCalculator
            project={project}
            profile={profile}
            onAdded={(created) => setMaterials((rows) => [...rows, ...created])}
          />

          <div className="card material-form">
            <h3>{t('mat_new_heading')}</h3>
            {drafts.map((row, idx) => (
              <div className="material-draft-row" key={idx}>
                <div className="material-edit-grid">
                  <input value={row.section} onChange={(e) => updateDraft(idx, { section: e.target.value })} placeholder={t('mat_col_section')} />
                  <div className="material-name-cell">
                    <input value={row.name} onChange={(e) => updateDraft(idx, { name: e.target.value })} placeholder={t('mat_col_name')} />
                    <VoiceMic lang={lang} title={t('mat_voice_hint')} onResult={(text) => updateDraft(idx, { name: row.name ? `${row.name} ${text}` : text })} />
                  </div>
                  <input className="material-qty" inputMode="decimal" value={row.qty} onChange={(e) => updateDraft(idx, { qty: e.target.value })} placeholder={t('mat_col_qty')} />
                  <input value={row.unit} onChange={(e) => updateDraft(idx, { unit: e.target.value })} placeholder={t('mat_col_unit')} />
                  <input value={row.supplier} onChange={(e) => updateDraft(idx, { supplier: e.target.value })} placeholder={t('mat_col_supplier')} />
                  <input value={row.url} onChange={(e) => updateDraft(idx, { url: e.target.value })} placeholder={t('mat_col_url')} />
                  <input value={row.note} onChange={(e) => updateDraft(idx, { note: e.target.value })} placeholder={t('mat_col_note')} />
                </div>
                {drafts.length > 1 && (
                  <button className="btn ghost small material-remove-draft" type="button" onClick={() => removeDraftRow(idx)} aria-label={t('mat_remove_row')}>×</button>
                )}
              </div>
            ))}
            <div className="row material-form-actions">
              <button className="btn ghost small" type="button" onClick={addDraftRow}>{t('mat_add_row')}</button>
              <button className="btn small" type="button" disabled={busy} onClick={saveNewRows}>{busy ? t('saving') : t('mat_save_spec')}</button>
            </div>
          </div>

          <div className="card material-import">
            <h3>{t('mat_import_heading')}</h3>
            <p className="muted">{t('mat_import_hint')}</p>
            <textarea rows={4} value={importText} onChange={(e) => setImportText(e.target.value)} placeholder={t('mat_import_placeholder')} />
            <div className="row material-form-actions">
              <label className="btn ghost small material-file-label">
                {t('mat_import_file')}
                <input type="file" accept=".csv,.tsv,text/csv,text/tab-separated-values" onChange={onImportFile} hidden />
              </label>
              <button className="btn small" type="button" disabled={busy || !importText.trim()} onClick={runImport}>{busy ? t('saving') : t('mat_import_run')}</button>
            </div>
            {importNotice != null && <p className="warn-msg">{t('mat_import_done')}: {importNotice}</p>}
          </div>
        </>
      )}

      {error && <p className="error-msg">{t(error)}</p>}

      {loading && <div className="card center muted">{t('loading')}</div>}
      {loadError && <p className="error-msg">{t('load_error')}</p>}
      {!loading && !loadError && materials.length === 0 && <div className="card muted">{t('mat_empty')}</div>}

      {!loading && !loadError && materials.length > 0 && (
        <div className="row material-list-toolbar">
          {canManage && (
            <>
              <label className="material-select-all">
                <input
                  type="checkbox"
                  checked={selectableMaterials.length > 0 && selectedMaterials.length === selectableMaterials.length}
                  disabled={deliveryBusy || selectableMaterials.length === 0}
                  onChange={(e) => toggleSelectAll(e.target.checked)}
                />
                <span>{t('mat_select_all')}</span>
              </label>
              <button
                className="btn small"
                type="button"
                disabled={deliveryBusy || selectedMaterials.length === 0}
                onClick={createDelivery}
              >
                {deliveryBusy ? t('saving') : t('mat_to_delivery')}
              </button>
              <span className="muted">{t('mat_selected_count').replace('{n}', String(selectedMaterials.length))}</span>
            </>
          )}
          <button className="btn ghost small" type="button" onClick={exportSpec}>{t('mat_export')}</button>
        </div>
      )}
      {deliveryNotice != null && <p className="ok-msg">{t('mat_delivery_created').replace('{n}', String(deliveryNotice))}</p>}

      {!loading && !loadError && materials.length > 0 && (
        <div className="material-list">
          {sections.map((section) => (
            <div className="material-section" key={section || '__none__'}>
              {section && <h4 className="material-section-title">{section}</h4>}
              {materials.filter((m) => (m.section ?? '') === section).map(renderRow)}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
