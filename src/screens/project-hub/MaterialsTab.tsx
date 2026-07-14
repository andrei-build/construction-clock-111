import { useEffect, useMemo, useState } from 'react'
import { useI18n } from '../../lib/i18n'
import VoiceMic from '../../components/VoiceMic'
import {
  bulkInsertProjectMaterials,
  getProjectMaterialTasks,
  getProjectMaterials,
  requestProjectMaterial,
  softDeleteProjectMaterial,
  subscribeToTaskChanges,
  updateProjectMaterial,
  type ProjectMaterialInput,
} from '../../lib/api'
import { isManagerWrite } from '../../lib/types'
import type { MaterialSpecStatus, ProjectMaterial, Profile, Project, Task } from '../../lib/types'

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
