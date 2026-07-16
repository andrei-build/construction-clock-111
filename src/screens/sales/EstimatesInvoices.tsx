import { useEffect, useMemo, useState } from 'react'
import {
  convertEstimateToInvoice,
  createEstimateDocument,
  detachDocumentFile,
  getDocumentAccounts,
  getDocumentFiles,
  getDocumentFileUrl,
  getDocumentItems,
  getDocumentProjects,
  getDocuments,
  getDocumentUnits,
  getVisibleProfileRates,
  markDocumentPaid,
  uploadDocumentFile,
  uploadErrorCode,
  type DocumentFileRow,
  type DocumentLineInput,
} from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { useI18n } from '../../lib/i18n'
import { isManagerWrite } from '../../lib/types'
import type { Account, DocumentItem, DocumentProjectOption, DocumentRow, DocumentType, ProfileRate, Unit } from '../../lib/types'

type FormItem = {
  id: string
  description: string
  qty: string
  unitId: string
  unitPrice: string
  markupPct: string
}

const localeByLang = {
  ru: 'ru-RU',
  en: 'en-US',
  es: 'es-ES',
} as const

function localId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`
}

function newItem(): FormItem {
  return {
    id: localId(),
    description: '',
    qty: '1',
    unitId: '',
    unitPrice: '',
    markupPct: '0',
  }
}

function dateValue(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function addDays(date: Date, days: number) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function parseAmount(value: string | number | null | undefined) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (!value) return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100
}

function lineTotal(item: FormItem) {
  const base = parseAmount(item.qty) * parseAmount(item.unitPrice)
  return roundMoney(base * (1 + parseAmount(item.markupPct) / 100))
}

function numberPrefix(type: DocumentType, date: string) {
  const label = type === 'estimate' ? 'EST' : 'INV'
  return `${label}-${date.slice(0, 7).replace('-', '')}`
}

function nextDocumentNumber(type: DocumentType, date: string, documents: DocumentRow[]) {
  const prefix = numberPrefix(type, date)
  const count = documents.filter((doc) => doc.doc_type === type && (doc.number ?? '').startsWith(prefix)).length
  return `${prefix}-${count + 1}`
}

function formatBytes(bytes: number | null | undefined) {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

function statusTone(status: DocumentRow['status']) {
  if (status === 'paid' || status === 'approved') return 'green'
  if (status === 'sent') return 'blue'
  if (status === 'void') return 'red'
  return 'amber'
}

// BRAND-1: «Закон двух компаний» — бренд клиента (accounts.brand). Нормализуем к одному из двух
// известных значений; всё неизвестное/пустое трактуем как дефолт 'nw_build_pro'.
type BrandKey = 'nw_build_pro' | 'nw_custom_homes'
const BRAND_KEYS: BrandKey[] = ['nw_build_pro', 'nw_custom_homes']
function brandKey(value: string | null | undefined): BrandKey {
  return value === 'nw_custom_homes' ? 'nw_custom_homes' : 'nw_build_pro'
}

// DOCS-2: смет/счётов менеджер, перенесён из «Документов» в «Продажи» дословно (нумерация, конверт
// в счёт, отметка оплаты, вложения FILE-1). initialType задаёт стартовую подвкладку из /sales?tab=.
export default function EstimatesInvoices({ initialType }: { initialType?: DocumentType }) {
  const { profile } = useAuth()
  const { t, lang } = useI18n()
  const [documents, setDocuments] = useState<DocumentRow[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [projects, setProjects] = useState<DocumentProjectOption[]>([])
  const [units, setUnits] = useState<Unit[]>([])
  const [rates, setRates] = useState<ProfileRate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [tab, setTab] = useState<DocumentType>(initialType ?? 'estimate')
  const [brandFilter, setBrandFilter] = useState<'all' | BrandKey>('all')
  const [showForm, setShowForm] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detailItems, setDetailItems] = useState<DocumentItem[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<DocumentFileRow[]>([])
  const [attachLoading, setAttachLoading] = useState(false)
  const [attachBusy, setAttachBusy] = useState(false)
  const [attachDetachId, setAttachDetachId] = useState<string | null>(null)

  const [title, setTitle] = useState('')
  const [accountId, setAccountId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [issueDate, setIssueDate] = useState(() => dateValue(new Date()))
  const [taxRate, setTaxRate] = useState('0')
  const [notes, setNotes] = useState('')
  const [formItems, setFormItems] = useState<FormItem[]>(() => [newItem()])

  async function loadData() {
    setLoading(true)
    setError(false)
    try {
      const [docRows, accountRows, projectRows, unitRows, rateRows] = await Promise.all([
        getDocuments(),
        getDocumentAccounts(),
        getDocumentProjects(),
        getDocumentUnits(),
        getVisibleProfileRates(),
      ])
      setDocuments(docRows)
      setAccounts(accountRows)
      setProjects(projectRows)
      setUnits(unitRows)
      setRates(rateRows)
    } catch {
      setDocuments([])
      setAccounts([])
      setProjects([])
      setUnits([])
      setRates([])
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let mounted = true
    async function run() {
      if (!mounted) return
      await loadData()
    }
    run()
    return () => { mounted = false }
  }, [profile?.id])

  useEffect(() => {
    if (!selectedId) {
      setDetailItems([])
      return
    }
    let mounted = true
    setDetailLoading(true)
    getDocumentItems(selectedId)
      .then((rows) => { if (mounted) setDetailItems(rows) })
      .catch(() => { if (mounted) setDetailItems([]) })
      .finally(() => { if (mounted) setDetailLoading(false) })
    return () => { mounted = false }
  }, [selectedId])

  useEffect(() => {
    if (!selectedId) {
      setAttachments([])
      return
    }
    let mounted = true
    setAttachLoading(true)
    getDocumentFiles(selectedId)
      .then((rows) => { if (mounted) setAttachments(rows) })
      .catch(() => { if (mounted) setAttachments([]) })
      .finally(() => { if (mounted) setAttachLoading(false) })
    return () => { mounted = false }
  }, [selectedId])

  const selected = documents.find((doc) => doc.id === selectedId) ?? null
  // BRAND-1: бренд по account_id — для пилюли в селекторе клиента и фильтра списка документов.
  const brandByAccount = useMemo(() => {
    const map = new Map<string, BrandKey>()
    for (const account of accounts) map.set(account.id, brandKey(account.brand))
    return map
  }, [accounts])
  const docBrand = (doc: DocumentRow) => (doc.account_id ? brandByAccount.get(doc.account_id) ?? 'nw_build_pro' : 'nw_build_pro')
  const activeDocuments = documents.filter((doc) =>
    doc.doc_type === tab && (brandFilter === 'all' || docBrand(doc) === brandFilter),
  )
  const canWriteAttachments = profile ? isManagerWrite(profile.role) : false
  const ownerOrAdmin = profile?.role === 'owner' || profile?.role === 'admin'
  const locked = !loading && !ownerOrAdmin && documents.length === 0 && rates.length === 0

  const formTotals = useMemo(() => {
    const subtotal = roundMoney(formItems.reduce((sum, item) => sum + lineTotal(item), 0))
    const taxAmount = roundMoney(subtotal * parseAmount(taxRate) / 100)
    return { subtotal, taxAmount, total: roundMoney(subtotal + taxAmount) }
  }, [formItems, taxRate])

  const money = (value: number | null | undefined) =>
    new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(parseAmount(value))

  const formatDate = (date: string | null | undefined) => (
    date ? new Intl.DateTimeFormat(localeByLang[lang], { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${date}T12:00:00`)) : '-'
  )

  const accountName = (doc: DocumentRow) => doc.account?.name ?? t('documents_no_client')
  const projectName = (doc: DocumentRow) => doc.project?.name ?? t('documents_no_project')
  const validLines = () => formItems
    .filter((item) => item.description.trim())
    .map<DocumentLineInput>((item) => ({
      description: item.description.trim(),
      qty: parseAmount(item.qty),
      unit_id: item.unitId || null,
      unit_price: parseAmount(item.unitPrice),
      markup_pct: parseAmount(item.markupPct),
      total: lineTotal(item),
    }))

  function resetForm() {
    setTitle('')
    setAccountId('')
    setProjectId('')
    setIssueDate(dateValue(new Date()))
    setTaxRate('0')
    setNotes('')
    setFormItems([newItem()])
  }

  function updateItem(id: string, patch: Partial<FormItem>) {
    setFormItems((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  }

  async function refreshDocuments() {
    const docRows = await getDocuments()
    setDocuments(docRows)
    return docRows
  }

  async function handleSaveEstimate(e: React.FormEvent) {
    e.preventDefault()
    if (!profile || busy) return
    const items = validLines()
    if (!title.trim() || !accountId || items.length === 0) return

    setBusy(true)
    setMsg(null)
    try {
      const id = await createEstimateDocument(profile, {
        number: nextDocumentNumber('estimate', issueDate, documents),
        title: title.trim(),
        accountId,
        projectId: projectId || null,
        issueDate,
        taxRate: parseAmount(taxRate),
        notes: notes.trim() || null,
        subtotal: formTotals.subtotal,
        taxAmount: formTotals.taxAmount,
        total: formTotals.total,
        items,
      })
      await refreshDocuments()
      setSelectedId(id)
      setTab('estimate')
      setShowForm(false)
      resetForm()
      setMsg('documents_estimate_created')
    } catch {
      setMsg('documents_save_failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleConvert() {
    if (!profile || !selected || selected.doc_type !== 'estimate' || busy) return
    const today = dateValue(new Date())
    setBusy(true)
    setMsg(null)
    try {
      const sourceItems = detailItems.length > 0 ? detailItems : await getDocumentItems(selected.id)
      const invoiceId = await convertEstimateToInvoice(profile, selected, sourceItems, {
        number: nextDocumentNumber('invoice', today, documents),
        issueDate: today,
        dueDate: dateValue(addDays(new Date(), 30)),
      })
      await refreshDocuments()
      setSelectedId(invoiceId)
      setTab('invoice')
      setMsg('documents_invoice_created')
    } catch {
      setMsg('documents_convert_failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleMarkPaid() {
    if (!profile || !selected || selected.doc_type !== 'invoice' || busy) return
    setBusy(true)
    setMsg(null)
    try {
      await markDocumentPaid(profile, selected)
      await refreshDocuments()
      setMsg('documents_invoice_paid')
    } catch {
      setMsg('documents_paid_failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleAttachUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.target
    const file = input.files?.[0]
    if (!profile || !selected || !file || attachBusy) { input.value = ''; return }
    setAttachBusy(true)
    setMsg(null)
    try {
      const created = await uploadDocumentFile(profile, selected, file)
      setAttachments((rows) => [created, ...rows])
    } catch (err) {
      setMsg(uploadErrorCode(err) ?? 'documents_attach_failed')
    } finally {
      setAttachBusy(false)
      input.value = ''
    }
  }

  async function handleAttachDownload(row: DocumentFileRow) {
    setMsg(null)
    try {
      const url = await getDocumentFileUrl(row.storage_path)
      if (!url) { setMsg('documents_attach_download_failed'); return }
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch {
      setMsg('documents_attach_download_failed')
    }
  }

  async function handleAttachDetach(row: DocumentFileRow) {
    if (!profile || attachDetachId) return
    if (!window.confirm(t('documents_attach_detach_confirm'))) return
    setAttachDetachId(row.id)
    setMsg(null)
    try {
      await detachDocumentFile(profile, row.id)
      setAttachments((rows) => rows.filter((r) => r.id !== row.id))
    } catch {
      setMsg('documents_attach_detach_failed')
    } finally {
      setAttachDetachId(null)
    }
  }

  return (
    <div className="documents-screen">
      <div className="row documents-head">
        <p className="muted">{t('documents_subtitle')}</p>
        {!locked && (
          <div className="documents-actions">
            <button type="button" className="btn small" onClick={() => setShowForm((value) => !value)}>
              {showForm ? t('close') : t('documents_create_estimate')}
            </button>
            <button type="button" className="btn ghost small" onClick={loadData} disabled={loading || busy}>
              {t('refresh')}
            </button>
          </div>
        )}
      </div>

      {msg && <p className={msg.endsWith('_failed') ? 'error-msg' : 'ok-msg'}>{t(msg)}</p>}
      {loading && <div className="card center muted">{t('loading')}</div>}
      {error && <p className="error-msg">{t('load_error')}</p>}
      {locked && (
        <div className="card payroll-lock">
          <div className="big">🔒</div>
          <div className="item-title">{t('documents_locked')}</div>
        </div>
      )}

      {!loading && !error && !locked && (
        <>
          {showForm && (
            <form className="card document-form" onSubmit={handleSaveEstimate}>
              <h2>{t('documents_create_estimate')}</h2>
              <div className="document-form-grid">
                <label>
                  {t('documents_title')}
                  <input value={title} onChange={(e) => setTitle(e.target.value)} required />
                </label>
                <label>
                  {t('documents_client')}
                  <select value={accountId} onChange={(e) => setAccountId(e.target.value)} required>
                    <option value="">{t('documents_choose_client')}</option>
                    {accounts.map((account) => (
                      // BRAND-1: <option> не может содержать пилюлю — дописываем бренд в текст опции.
                      <option key={account.id} value={account.id}>{account.name} · {t(`brand_${brandKey(account.brand)}`)}</option>
                    ))}
                  </select>
                </label>
                <label>
                  {t('documents_project')}
                  <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                    <option value="">{t('documents_optional_project')}</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>{project.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  {t('documents_issue_date')}
                  <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} required />
                </label>
                <label>
                  {t('documents_tax_rate')}
                  <input type="number" min="0" step="0.01" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} />
                </label>
                <label className="span2">
                  {t('documents_notes')}
                  <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
                </label>
              </div>

              <div className="document-items-head">
                <h2>{t('documents_items')}</h2>
                <button type="button" className="btn ghost small" onClick={() => setFormItems((rows) => [...rows, newItem()])}>
                  {t('documents_add_item')}
                </button>
              </div>

              <div className="document-items-editor">
                {formItems.map((item, index) => (
                  <div key={item.id} className="document-item-row">
                    <label>
                      {t('documents_description')}
                      <input value={item.description} onChange={(e) => updateItem(item.id, { description: e.target.value })} required={index === 0} />
                    </label>
                    <label>
                      {t('documents_qty')}
                      <input type="number" min="0" step="0.01" value={item.qty} onChange={(e) => updateItem(item.id, { qty: e.target.value })} />
                    </label>
                    <label>
                      {t('documents_unit')}
                      <select value={item.unitId} onChange={(e) => updateItem(item.id, { unitId: e.target.value })}>
                        <option value="">{t('documents_no_unit')}</option>
                        {units.map((unit) => (
                          <option key={unit.id} value={unit.id}>{unit.abbreviation ?? unit.name}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {t('documents_unit_price')}
                      <input type="number" min="0" step="0.01" value={item.unitPrice} onChange={(e) => updateItem(item.id, { unitPrice: e.target.value })} />
                    </label>
                    <label>
                      {t('documents_markup_pct')}
                      <input type="number" step="0.01" value={item.markupPct} onChange={(e) => updateItem(item.id, { markupPct: e.target.value })} />
                    </label>
                    <div className="document-line-total">
                      <label>{t('documents_line_total')}</label>
                      <strong>{money(lineTotal(item))}</strong>
                    </div>
                    <div className="document-item-actions">
                      <button
                        type="button"
                        className="btn ghost small"
                        disabled={formItems.length === 1}
                        onClick={() => setFormItems((rows) => rows.filter((row) => row.id !== item.id))}
                      >
                        {t('remove')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="document-totals">
                <div><span>{t('documents_subtotal')}</span><strong>{money(formTotals.subtotal)}</strong></div>
                <div><span>{t('documents_tax_amount')}</span><strong>{money(formTotals.taxAmount)}</strong></div>
                <div><span>{t('total')}</span><strong>{money(formTotals.total)}</strong></div>
              </div>

              <button type="submit" className="btn" disabled={busy || !title.trim() || !accountId || validLines().length === 0}>
                {busy ? t('documents_saving') : t('documents_save_estimate')}
              </button>
            </form>
          )}

          <div className="tabs">
            <button type="button" className={tab === 'estimate' ? 'active' : ''} onClick={() => setTab('estimate')}>
              {t('documents_estimates')}
            </button>
            <button type="button" className={tab === 'invoice' ? 'active' : ''} onClick={() => setTab('invoice')}>
              {t('documents_invoices')}
            </button>
          </div>

          {/* BRAND-1: фильтр списка документов по бренду клиента (Все | NW Build Pro | NW Custom Homes). */}
          <label className="documents-brand-filter" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0' }}>
            <span className="muted" style={{ fontSize: '.85rem' }}>{t('brand_label')}</span>
            <select
              value={brandFilter}
              aria-label={t('brand_label')}
              onChange={(e) => {
                const value = e.target.value
                setBrandFilter(value === 'nw_build_pro' || value === 'nw_custom_homes' ? value : 'all')
              }}
            >
              <option value="all">{t('brand_filter_all')}</option>
              {BRAND_KEYS.map((key) => (
                <option key={key} value={key}>{t(`brand_${key}`)}</option>
              ))}
            </select>
          </label>

          {activeDocuments.length === 0 && <div className="card muted">{t('documents_empty')}</div>}
          {activeDocuments.length > 0 && (
            <div className="card documents-table-wrap">
              <table className="documents-table">
                <thead>
                  <tr>
                    <th>{t('documents_number')}</th>
                    <th>{t('documents_title')}</th>
                    <th>{t('documents_client')}</th>
                    <th>{t('documents_project')}</th>
                    <th>{t('documents_issue_date')}</th>
                    <th>{t('documents_status')}</th>
                    <th>{t('total')}</th>
                  </tr>
                </thead>
                <tbody>
                  {activeDocuments.map((doc) => (
                    <tr
                      key={doc.id}
                      className={doc.id === selectedId ? 'selected' : ''}
                      onClick={() => setSelectedId(doc.id)}
                    >
                      <td>{doc.number ?? '-'}</td>
                      <td>{doc.title ?? '-'}</td>
                      <td>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          {accountName(doc)}
                          {/* BRAND-1: read-only пилюля бренда клиента рядом с именем. */}
                          <span className={`badge ${docBrand(doc) === 'nw_custom_homes' ? 'blue' : 'green'} client-brand-badge`}>{t(`brand_${docBrand(doc)}`)}</span>
                        </span>
                      </td>
                      <td>{projectName(doc)}</td>
                      <td>{formatDate(doc.issue_date)}</td>
                      <td><span className={`badge ${statusTone(doc.status)}`}>{t(`document_status_${doc.status}`)}</span></td>
                      <td>{money(doc.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {selected && (
            <div className="card document-detail">
              <div className="row document-detail-head">
                <div>
                  <h2>{selected.number ?? t('documents_detail')}</h2>
                  <div className="item-title">{selected.title ?? '-'}</div>
                  <div className="muted">
                    {accountName(selected)} · {projectName(selected)} · {formatDate(selected.issue_date)}
                    {selected.due_date && <> · {t('documents_due_date')}: {formatDate(selected.due_date)}</>}
                  </div>
                </div>
                <span className={`badge ${statusTone(selected.status)}`}>{t(`document_status_${selected.status}`)}</span>
              </div>

              <div className="document-detail-actions">
                {selected.doc_type === 'estimate' && (
                  <button type="button" className="btn small" disabled={busy || detailLoading} onClick={handleConvert}>
                    {t('documents_convert_to_invoice')}
                  </button>
                )}
                {selected.doc_type === 'invoice' && selected.status !== 'paid' && (
                  <button type="button" className="btn small" disabled={busy} onClick={handleMarkPaid}>
                    {t('documents_mark_paid')}
                  </button>
                )}
              </div>

              {detailLoading && <div className="muted">{t('loading')}</div>}
              {!detailLoading && detailItems.length === 0 && <div className="muted">{t('documents_no_items')}</div>}
              {!detailLoading && detailItems.length > 0 && (
                <div className="documents-table-wrap detail-items-wrap">
                  <table className="documents-table detail-items-table">
                    <thead>
                      <tr>
                        <th>{t('documents_description')}</th>
                        <th>{t('documents_qty')}</th>
                        <th>{t('documents_unit')}</th>
                        <th>{t('documents_unit_price')}</th>
                        <th>{t('documents_markup_pct')}</th>
                        <th>{t('total')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailItems.map((item) => (
                        <tr key={item.id}>
                          <td>{item.description}</td>
                          <td>{parseAmount(item.qty).toFixed(2)}</td>
                          <td>{item.unit?.abbreviation ?? item.unit?.name ?? '-'}</td>
                          <td>{money(item.unit_price)}</td>
                          <td>{parseAmount(item.markup_pct).toFixed(2)}%</td>
                          <td>{money(item.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="document-totals detail-totals">
                <div><span>{t('documents_subtotal')}</span><strong>{money(selected.subtotal)}</strong></div>
                <div><span>{t('documents_tax_amount')}</span><strong>{money(selected.tax_amount)}</strong></div>
                <div><span>{t('total')}</span><strong>{money(selected.total)}</strong></div>
                {selected.doc_type === 'invoice' && (
                  <div><span>{t('documents_balance')}</span><strong>{money(selected.balance)}</strong></div>
                )}
              </div>

              <div className="document-attachments">
                <div className="document-items-head">
                  <h2>{t('documents_attachments')}</h2>
                  {canWriteAttachments && (
                    <label className="btn ghost small document-attach-btn">
                      {attachBusy ? t('documents_attach_uploading') : t('documents_attach_file')}
                      <input
                        type="file"
                        hidden
                        disabled={attachBusy}
                        onChange={handleAttachUpload}
                      />
                    </label>
                  )}
                </div>

                {attachLoading && <div className="muted">{t('loading')}</div>}
                {!attachLoading && attachments.length === 0 && (
                  <div className="muted">{t('documents_attachments_empty')}</div>
                )}
                {!attachLoading && attachments.length > 0 && (
                  <ul className="document-attach-list">
                    {attachments.map((file) => (
                      <li key={file.id} className="document-attach-item">
                        <button type="button" className="link-btn document-attach-name" onClick={() => handleAttachDownload(file)}>
                          {file.name}
                        </button>
                        {formatBytes(file.size_bytes) && <span className="muted">{formatBytes(file.size_bytes)}</span>}
                        <span className="muted">{formatDate(file.created_at.slice(0, 10))}</span>
                        {canWriteAttachments && (
                          <button
                            type="button"
                            className="btn ghost small"
                            disabled={attachDetachId === file.id}
                            onClick={() => handleAttachDetach(file)}
                          >
                            {t('documents_attach_detach')}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
