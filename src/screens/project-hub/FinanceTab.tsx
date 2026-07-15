import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '../../lib/i18n'
import { getProjectDocuments, getProjectExpenses } from '../../lib/api'
import { hasFinanceAccess } from '../../lib/types'
import type { DocumentRow, Profile, Project, ProjectExpense } from '../../lib/types'

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
