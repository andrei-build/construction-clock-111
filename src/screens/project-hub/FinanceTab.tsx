import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '../../lib/i18n'
import {
  getProjectDocuments,
  getProjectExpenses,
  getProjectHubFiles,
  getProjectFileDownloadUrl,
  mediaUrl,
  listEstimateDrafts,
  listEstimateItems,
  updateEstimateStatus,
  listPlanPins,
  createPlanPin,
  type EstimateDraft,
  type EstimateItem,
} from '../../lib/api'
import {
  canTransition,
  computeTotals,
  flagEmoji,
  nextStatus,
  sourceKind,
  sourcePage,
  sourceFileId,
  type EstimateStatus,
} from '../../lib/estimateCore'
import { hasFinanceAccess } from '../../lib/types'
import type { DocumentRow, Profile, Project, ProjectExpense, ProjectHubFile } from '../../lib/types'
import { useFileViewer } from '../../components/FileViewer'

interface FinanceTabProps {
  project: Project
  profile: Profile | null
}

function money(value: number | null | undefined) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value ?? 0)
}

function formatDate(value: string | null | undefined) {
  if (!value) return null
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString()
}

function statusTone(status: DocumentRow['status']) {
  if (status === 'paid' || status === 'approved') return 'green'
  if (status === 'sent') return 'blue'
  if (status === 'void') return 'red'
  return 'amber'
}

// ESTIMATE-REVIEW-39: тон бейджа статуса черновика сметы (draft→review→approved).
function estimateStatusTone(status: EstimateStatus) {
  if (status === 'approved') return 'green'
  if (status === 'review') return 'blue'
  return 'amber'
}

// Кол-во без хвостовых нулей (2 знака max) — «12», «12.5», «0.75».
function formatQty(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value ?? 0)
}

// ESTIMATE-REVIEW-39 (серия PLAN-TO-ESTIMATE, 3/4): экран «Смета (черновик)» в Финансах.
// Список черновиков (estimate_drafts) → таблица строк (estimate_items) с флагами/источниками/итогами,
// кнопки статуса draft→review→approved (утверждает ЧЕЛОВЕК), и клик по строке с source.page →
// встроенный FileViewer (#37) на нужной странице с подсветкой связанного пина (#38). Только read+update.
// Доступ уже гейтит родительская Финанс-панель (hasFinanceAccess) + RLS — роль здесь не дублируем.
function EstimatesCard({ project, profile }: { project: Project; profile: Profile | null }) {
  const { t } = useI18n()
  const [drafts, setDrafts] = useState<EstimateDraft[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [items, setItems] = useState<EstimateItem[]>([])
  const [itemsLoading, setItemsLoading] = useState(false)
  const [statusBusy, setStatusBusy] = useState(false)
  const [statusError, setStatusError] = useState(false)
  const [rowBusyId, setRowBusyId] = useState<string | null>(null)
  // id файла → строка files, чтобы клик по строке резолвил source.file_id в подписанный URL.
  const [fileMap, setFileMap] = useState<Record<string, ProjectHubFile>>({})
  const fv = useFileViewer()
  // Гонка: пока грузим строки одного черновика, пользователь мог открыть другой — сверяем по ref.
  const openRef = useRef<string | null>(null)

  useEffect(() => {
    if (!profile) return
    let mounted = true
    ;(async () => {
      setLoading(true)
      setLoadError(false)
      try {
        const [ds, files] = await Promise.all([
          listEstimateDrafts(profile, { projectId: project.id }),
          getProjectHubFiles(project.id),
        ])
        if (!mounted) return
        setDrafts(ds)
        setFileMap(Object.fromEntries(files.map((f) => [f.id, f])))
      } catch {
        if (mounted) setLoadError(true)
      } finally {
        if (mounted) setLoading(false)
      }
    })()
    return () => { mounted = false }
  }, [project.id, profile])

  const openDraft = async (draft: EstimateDraft) => {
    if (openId === draft.id) { setOpenId(null); openRef.current = null; return }
    setOpenId(draft.id)
    openRef.current = draft.id
    setItems([])
    setStatusError(false)
    if (!profile) return
    setItemsLoading(true)
    try {
      const rows = await listEstimateItems(profile, { draftId: draft.id })
      if (openRef.current === draft.id) setItems(rows)
    } catch {
      if (openRef.current === draft.id) setItems([])
    } finally {
      if (openRef.current === draft.id) setItemsLoading(false)
    }
  }

  const changeStatus = async (draft: EstimateDraft, to: EstimateStatus) => {
    if (statusBusy || !profile || !canTransition(draft.status, to)) return
    setStatusBusy(true)
    setStatusError(false)
    try {
      const updated = await updateEstimateStatus(profile, { draftId: draft.id, status: to })
      setDrafts((prev) => prev.map((d) => (d.id === updated.id ? updated : d)))
    } catch {
      setStatusError(true)
    } finally {
      setStatusBusy(false)
    }
  }

  // Файл для строки: source.file_id, иначе — единственный файл черновика (когда источник один).
  const resolveFileId = (item: EstimateItem, draft: EstimateDraft): string | null =>
    sourceFileId(item.source) ?? (draft.source_file_ids.length === 1 ? draft.source_file_ids[0] : null)

  // Клик по строке с привязкой к странице → встроенный просмотрщик на нужной странице + подсветка пина.
  const openRowFile = async (item: EstimateItem, draft: EstimateDraft) => {
    const page = sourcePage(item.source)
    const fileId = resolveFileId(item, draft)
    if (!page || !fileId) return
    const file = fileMap[fileId]
    if (!file || rowBusyId) return
    setRowBusyId(item.id)
    try {
      const url = file.scope === 'project'
        ? await getProjectFileDownloadUrl(file)
        : await mediaUrl(file.storage_path)
      if (!url) return
      const pins = profile ? await listPlanPins(profile, { projectId: project.id, fileId: file.id }) : []
      const highlight = pins.find((p) => p.estimate_item_id === item.id) ?? null
      const canAddPin = !!profile && (profile.role === 'owner' || profile.role === 'admin')
      fv.open({
        url,
        name: file.name,
        mime: file.mime,
        page,
        highlightPinId: highlight?.id ?? null,
        pins,
        canAddPin,
        onAddPin: profile
          ? (dr) => createPlanPin(profile, {
              projectId: project.id,
              fileId: file.id,
              page: dr.page,
              bbox: dr.bbox,
              severity: dr.severity,
              kind: dr.kind,
              title: dr.title,
              note: dr.note,
            })
          : undefined,
      })
    } catch {
      // Строка просто не открыла файл — не роняем экран сметы.
    } finally {
      setRowBusyId(null)
    }
  }

  // i18n-подпись бейджа источника (страница/правило/норма/каталог), номер страницы дописываем сами
  // (t без интерполяции). Неизвестный источник → null (бейдж не рисуем).
  const sourceBadge = (item: EstimateItem): string | null => {
    const kind = sourceKind(item.source)
    if (kind === 'unknown') return null
    if (kind === 'page') {
      const p = sourcePage(item.source)
      return p ? `${t('estimate_source_page')} ${p}` : t('estimate_source_page')
    }
    return t(`estimate_source_${kind}`)
  }

  const openDraftRow = drafts.find((d) => d.id === openId) ?? null
  const totals = openDraftRow
    ? (items.length ? computeTotals(items, openDraftRow.contingency_pct) : { subtotal: openDraftRow.subtotal, total: openDraftRow.total })
    : { subtotal: 0, total: 0 }

  return (
    <div className="card estimate-card">
      <h2>{t('estimate_title')}</h2>

      {loading && <div className="center muted">{t('loading')}</div>}
      {loadError && <p className="error-msg">{t('estimate_load_error')}</p>}
      {!loading && !loadError && drafts.length === 0 && (
        <p className="muted">{t('estimate_empty')}</p>
      )}

      {!loading && !loadError && drafts.length > 0 && (
        <div className="estimate-drafts">
          {drafts.map((draft) => {
            const isOpen = openId === draft.id
            const forward = nextStatus(draft.status)
            return (
              <div className={`estimate-draft${isOpen ? ' open' : ''}`} key={draft.id}>
                <button
                  type="button"
                  className="estimate-draft-head"
                  aria-expanded={isOpen}
                  onClick={() => openDraft(draft)}
                >
                  <span className="estimate-draft-caret" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                  <span className="item-title estimate-draft-title">{draft.title || t('estimate_untitled')}</span>
                  <span className={`badge ${estimateStatusTone(draft.status)} estimate-status-badge`}>
                    {t(`estimate_status_${draft.status}`)}
                  </span>
                  <span className="estimate-draft-total num-display">{money(draft.total)}</span>
                </button>

                {isOpen && (
                  <div className="estimate-detail">
                    {/* Статус draft→review→approved: следующий шаг одной кнопкой. Утверждает ЧЕЛОВЕК. */}
                    <div className="estimate-actions">
                      <span className="muted estimate-actions-label">{t('estimate_status_label')}</span>
                      {forward ? (
                        <button
                          type="button"
                          className={`btn small ${forward === 'approved' ? 'primary' : ''}`}
                          disabled={statusBusy}
                          onClick={() => changeStatus(draft, forward)}
                        >
                          {forward === 'review' ? t('estimate_action_to_review') : t('estimate_action_approve')}
                        </button>
                      ) : (
                        <span className="badge green estimate-status-badge">✓ {t('estimate_status_approved')}</span>
                      )}
                      {statusError && <span className="error-msg estimate-status-error">{t('estimate_status_failed')}</span>}
                    </div>

                    {itemsLoading && <div className="center muted">{t('loading')}</div>}
                    {!itemsLoading && items.length === 0 && (
                      <p className="muted">{t('estimate_items_empty')}</p>
                    )}

                    {!itemsLoading && items.length > 0 && (
                      <>
                        <div className="estimate-table-wrap">
                          <table className="estimate-table">
                            <thead>
                              <tr>
                                <th>{t('estimate_col_section')}</th>
                                <th>{t('estimate_col_desc')}</th>
                                <th className="num">{t('estimate_col_qty')}</th>
                                <th>{t('estimate_col_unit')}</th>
                                <th className="num">{t('estimate_col_price')}</th>
                                <th className="num">{t('estimate_col_total')}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {items.map((item) => {
                                const page = sourcePage(item.source)
                                const fileId = resolveFileId(item, draft)
                                const clickable = !!page && !!fileId && !!fileMap[fileId]
                                const emoji = flagEmoji(item.flag)
                                const badge = sourceBadge(item)
                                return (
                                  <tr
                                    key={item.id}
                                    className={`estimate-row${clickable ? ' clickable' : ''}${rowBusyId === item.id ? ' busy' : ''}`}
                                    onClick={clickable ? () => openRowFile(item, draft) : undefined}
                                  >
                                    <td className="estimate-cell-section">{item.section || '—'}</td>
                                    <td className="estimate-cell-desc">
                                      <span className="estimate-desc-text">{item.description || '—'}</span>
                                      <span className="estimate-tags">
                                        {emoji && <span className="estimate-flag" aria-hidden="true">{emoji}</span>}
                                        {badge && <span className="badge grey estimate-source-badge">{badge}</span>}
                                        {item.needs_measure && (
                                          <span className="badge amber estimate-measure">📏 {t('estimate_needs_measure')}</span>
                                        )}
                                        {clickable && (
                                          <span className="estimate-open-hint">🔎 {t('estimate_open_page')}</span>
                                        )}
                                      </span>
                                    </td>
                                    <td className="num">{formatQty(item.qty)}</td>
                                    <td>{item.unit || '—'}</td>
                                    <td className="num">{money(item.unit_price)}</td>
                                    <td className="num">{money(item.line_total)}</td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>

                        <div className="estimate-totals">
                          <div className="estimate-total-row">
                            <span className="muted">{t('estimate_subtotal')}</span>
                            <span className="num-display">{money(totals.subtotal)}</span>
                          </div>
                          <div className="estimate-total-row">
                            <span className="muted">{t('estimate_contingency')}</span>
                            <span className="num-display">{formatQty(draft.contingency_pct)}%</span>
                          </div>
                          <div className="estimate-total-row estimate-total-grand">
                            <span>{t('estimate_total')}</span>
                            <span className="num-display">{money(totals.total)}</span>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {fv.node}
    </div>
  )
}

export default function FinanceTab({ project, profile }: FinanceTabProps) {
  const { t } = useI18n()
  // A2: доступ к финансам = owner/admin ИЛИ гранта finance_access (единый предикат hasFinanceAccess).
  const financeAllowed = hasFinanceAccess(profile)
  const [documents, setDocuments] = useState<DocumentRow[]>([])
  const [expenses, setExpenses] = useState<ProjectExpense[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    if (!financeAllowed) return
    let mounted = true
    ;(async () => {
      setLoading(true)
      setLoadError(false)
      try {
        const [docs, exp] = await Promise.all([
          getProjectDocuments(project.id),
          getProjectExpenses(project.id),
        ])
        if (!mounted) return
        setDocuments(docs)
        setExpenses(exp)
      } catch {
        if (mounted) setLoadError(true)
      } finally {
        if (mounted) setLoading(false)
      }
    })()
    return () => { mounted = false }
  }, [project.id, financeAllowed])

  const totals = useMemo(() => {
    let estimates = 0
    let invoices = 0
    let paid = 0
    for (const doc of documents) {
      if (doc.doc_type === 'estimate') estimates += doc.total ?? 0
      if (doc.doc_type === 'invoice') {
        invoices += doc.total ?? 0
        paid += doc.amount_paid ?? 0
      }
    }
    return { estimates, invoices, paid }
  }, [documents])

  const expensesTotal = useMemo(
    () => expenses.reduce((sum, expense) => sum + (expense.amount ?? 0), 0),
    [expenses],
  )

  if (!financeAllowed) {
    return (
      <section className="hub-tab-panel hub-finance">
        <div className="card payroll-lock">
          <div className="big">🔒</div>
          <div className="item-title">{t('hub_finance_locked')}</div>
        </div>
      </section>
    )
  }

  return (
    <section className="hub-tab-panel hub-finance">
      {loading && <div className="card center muted">{t('loading')}</div>}
      {loadError && <p className="error-msg">{t('hub_finance_load_error')}</p>}

      {!loading && !loadError && (
        <>
          <EstimatesCard project={project} profile={profile} />

          <div className="card">
            <h2>{t('hub_finance_documents_title')}</h2>
            <div className="hub-finance-totals">
              <div className="hub-finance-stat">
                <span className="muted">{t('hub_finance_estimates_total')}</span>
                <span className="item-title num-display">{money(totals.estimates)}</span>
              </div>
              <div className="hub-finance-stat">
                <span className="muted">{t('hub_finance_invoices_total')}</span>
                <span className="item-title num-display">{money(totals.invoices)}</span>
              </div>
              <div className="hub-finance-stat">
                <span className="muted">{t('hub_finance_paid_total')}</span>
                <span className="item-title num-display">{money(totals.paid)}</span>
              </div>
            </div>

            {documents.length === 0 ? (
              <p className="muted">{t('hub_finance_empty')}</p>
            ) : (
              <div className="hub-finance-list">
                {documents.map((doc) => (
                  <div className="hub-finance-row" key={doc.id}>
                    <div className="hub-finance-info">
                      <span className="item-title">
                        {t(`hub_doc_type_${doc.doc_type}`)}
                        {doc.number ? ` · ${doc.number}` : ''}
                      </span>
                      <span className="muted">
                        {doc.title ?? '—'}
                        {' · '}
                        <span className={`badge ${statusTone(doc.status)}`}>{t(`hub_doc_status_${doc.status}`)}</span>
                      </span>
                    </div>
                    <span className="hub-finance-total num-display">{money(doc.total)}</span>
                  </div>
                ))}
              </div>
            )}

            <Link className="inline-link hub-finance-link" to="/documents">{t('hub_finance_open_documents')}</Link>
          </div>

          <div className="card">
            <h2>{t('hub_finance_expenses_title')}</h2>
            <div className="hub-finance-totals">
              <div className="hub-finance-stat">
                <span className="muted">{t('hub_finance_expenses_total')}</span>
                <span className="item-title num-display">{money(expensesTotal)}</span>
              </div>
            </div>

            {expenses.length === 0 ? (
              <p className="muted">{t('hub_finance_expenses_empty')}</p>
            ) : (
              <div className="hub-finance-list">
                {expenses.map((expense) => {
                  const title = expense.description || expense.kind || '—'
                  // kind показываем в подписи только если он не занял место заголовка
                  const sub = [expense.description ? expense.kind : null, expense.vendor, formatDate(expense.incurred_at)]
                    .filter(Boolean)
                    .join(' · ')
                  return (
                    <div className="hub-finance-row" key={expense.id}>
                      <div className="hub-finance-info">
                        <span className="item-title">{title}</span>
                        {sub && <span className="muted">{sub}</span>}
                      </div>
                      <span className="hub-finance-total num-display">{money(expense.amount)}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  )
}
