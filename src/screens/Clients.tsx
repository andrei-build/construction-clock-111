import { useEffect, useMemo, useState } from 'react'
import AccountForm from '../components/AccountForm'
import { useEntityDrawer } from '../components/EntityDrawer'
import { createAccount, getClientAccounts, getClientProjectSummaries, updateClientBrand, updateClientRating } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { isManagerWrite } from '../lib/types'
import type { Account, AccountInput, ClientDifficulty, ClientProjectSummary } from '../lib/types'

function isKnownAccountType(type: string | null): type is 'client' | 'gc' | 'supplier' | 'other' {
  return type === 'client' || type === 'gc' || type === 'supplier' || type === 'other'
}

function accountTypeLabel(t: (key: string) => string, type: string | null) {
  return isKnownAccountType(type) ? t(`account_type_${type}`) : type ?? t('account_type_other')
}

function accountTypeTone(type: string | null) {
  if (type === 'client') return 'green'
  if (type === 'gc') return 'blue'
  if (type === 'supplier') return 'amber'
  return 'red'
}

function sortAccounts(rows: Account[]) {
  return [...rows].sort((a, b) => a.name.localeCompare(b.name))
}

// BRAND-1: «Закон двух компаний» — два бренда клиента (accounts.brand). Нормализуем к одному из
// двух известных значений; всё неизвестное/пустое трактуем как дефолт 'nw_build_pro'.
type BrandKey = 'nw_build_pro' | 'nw_custom_homes'
const BRAND_KEYS: BrandKey[] = ['nw_build_pro', 'nw_custom_homes']
function brandKey(value: string | null | undefined): BrandKey {
  return value === 'nw_custom_homes' ? 'nw_custom_homes' : 'nw_build_pro'
}

// BRAND-1: read-only пилюля бренда рядом с именем клиента.
function BrandBadge({ account }: { account: Account }) {
  const { t } = useI18n()
  const key = brandKey(account.brand)
  return <span className={`badge ${key === 'nw_custom_homes' ? 'blue' : 'green'} client-brand-badge`}>{t(`brand_${key}`)}</span>
}

// CLI-1: нормализуем рейтинг к 1..5 или null (защита от мусора из БД).
function clientRating(account: Account): number | null {
  const r = account.rating
  return typeof r === 'number' && r >= 1 && r <= 5 ? Math.round(r) : null
}

function clientDifficulty(account: Account): ClientDifficulty | null {
  const d = account.difficulty
  return d === 'easy' || d === 'normal' || d === 'hard' ? d : null
}

// CLI-1: компактный read-only бейдж «★4 · Сложный». Без оценки и без сложности → ничего.
// ВНУТРЕННИЙ ярлык (owner/admin/manager видят экран «Клиенты»); клиенту никогда не показывается.
function ClientRatingBadge({ account }: { account: Account }) {
  const { t } = useI18n()
  const rating = clientRating(account)
  const difficulty = clientDifficulty(account)
  if (rating === null && difficulty === null) return null
  const parts: string[] = []
  if (rating !== null) parts.push(`★${rating}`)
  if (difficulty !== null) parts.push(t(`client_difficulty_${difficulty}`))
  return <span className="badge grey client-rating-badge">{parts.join(' · ')}</span>
}

// CLI-1: редактор оценки — звёзды 1..5 + селект сложности. Только owner/admin/manager (RLS дублирует
// гейт на сервере). Повторный клик по текущей звезде сбрасывает рейтинг. Сохраняем сразу; при ошибке
// (RLS/сеть) тихо оставляем прежнее значение.
function ClientRatingEditor({ account, onUpdated }: { account: Account; onUpdated: (account: Account) => void }) {
  const { t } = useI18n()
  const { profile } = useAuth()
  const [saving, setSaving] = useState(false)
  const rating = clientRating(account)
  const difficulty = clientDifficulty(account)

  async function persist(next: { rating: number | null; difficulty: ClientDifficulty | null }) {
    if (!profile || saving) return
    setSaving(true)
    try {
      const updated = await updateClientRating(profile, account.id, next)
      onUpdated(updated)
    } catch {
      /* RLS/сеть — тихо, значение не меняем */
    } finally {
      setSaving(false)
    }
  }

  const pickStar = (n: number) => persist({ rating: rating === n ? null : n, difficulty })
  const pickDifficulty = (value: string) =>
    persist({ rating, difficulty: value === 'easy' || value === 'normal' || value === 'hard' ? value : null })

  return (
    <div className="client-rating-editor" style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
      <span className="muted" style={{ fontSize: '.85rem' }}>{t('client_rating_label')}</span>
      <div className="client-rating-stars" role="group" aria-label={t('client_rating_label')}>
        {[1, 2, 3, 4, 5].map((n) => {
          const on = rating !== null && n <= rating
          return (
            <button
              key={n}
              type="button"
              className="client-star-btn"
              disabled={saving}
              aria-pressed={on}
              aria-label={t('client_rating_set').replace('{n}', String(n))}
              title={t('client_rating_set').replace('{n}', String(n))}
              onClick={() => pickStar(n)}
              style={{ background: 'none', border: 'none', padding: '0 1px', cursor: saving ? 'default' : 'pointer', fontSize: '1.15rem', lineHeight: 1, color: on ? '#e6a817' : 'var(--muted, #8a94a6)' }}
            >
              {on ? '★' : '☆'}
            </button>
          )
        })}
      </div>
      <label className="client-difficulty-field" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className="muted" style={{ fontSize: '.85rem' }}>{t('client_difficulty_label')}</span>
        <select
          className="client-difficulty-select"
          value={difficulty ?? ''}
          disabled={saving}
          aria-label={t('client_difficulty_label')}
          onChange={(e) => pickDifficulty(e.target.value)}
        >
          <option value="">{t('client_difficulty_unset')}</option>
          <option value="easy">{t('client_difficulty_easy')}</option>
          <option value="normal">{t('client_difficulty_normal')}</option>
          <option value="hard">{t('client_difficulty_hard')}</option>
        </select>
      </label>
    </div>
  )
}

export default function Clients() {
  const { profile } = useAuth()
  const { t } = useI18n()
  const { openClient } = useEntityDrawer()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [projects, setProjects] = useState<ClientProjectSummary[]>([])
  const [search, setSearch] = useState('')
  const [brandFilter, setBrandFilter] = useState<'all' | BrandKey>('all')
  const [newBrand, setNewBrand] = useState<BrandKey>('nw_build_pro')
  const [adding, setAdding] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(false)

  useEffect(() => {
    let mounted = true
    async function load() {
      setLoading(true)
      setError(false)
      try {
        const [accountRows, projectRows] = await Promise.all([
          getClientAccounts(),
          getClientProjectSummaries(),
        ])
        if (!mounted) return
        setAccounts(accountRows)
        setProjects(projectRows)
      } catch {
        if (mounted) {
          setAccounts([])
          setProjects([])
          setError(true)
        }
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => { mounted = false }
  }, [profile?.id])

  const projectCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const project of projects) {
      if (!project.client_account_id) continue
      counts.set(project.client_account_id, (counts.get(project.client_account_id) ?? 0) + 1)
    }
    return counts
  }, [projects])

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return accounts.filter((account) => {
      if (brandFilter !== 'all' && brandKey(account.brand) !== brandFilter) return false
      if (needle && !account.name.toLowerCase().includes(needle)) return false
      return true
    })
  }, [accounts, search, brandFilter])

  // CLI-1: редактировать внутреннюю оценку клиента может только owner/admin/manager; остальные
  // видят read-only бейдж. RLS дублирует этот гейт на сервере.
  const canEditRating = profile ? isManagerWrite(profile.role) : false

  function replaceAccount(account: Account) {
    setAccounts((rows) => sortAccounts(rows.map((row) => (row.id === account.id ? account : row))))
  }

  async function addAccount(input: AccountInput) {
    if (!profile || saving) return
    setSaving(true)
    setSaveError(false)
    try {
      let created = await createAccount(profile, input)
      // BRAND-1: createAccount не принимает brand (AccountInput не трогаем) — если менеджер выбрал
      // не дефолтный бренд на форме, дописываем его отдельным updateClientBrand по новому id.
      if (canEditRating && newBrand !== 'nw_build_pro') {
        created = await updateClientBrand(profile, created.id, newBrand)
      }
      setAccounts((rows) => sortAccounts([...rows, created]))
      setAdding(false)
      setNewBrand('nw_build_pro')
    } catch {
      setSaveError(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="screen clients-screen">
      <div className="clients-head row">
        <div>
          <h1>👥 {t('clients')}</h1>
          <p className="muted">{t('clients_directory')}</p>
        </div>
        <button type="button" className="btn ghost small" onClick={() => setAdding((value) => !value)}>
          {adding ? t('cancel') : `+ ${t('clients_add')}`}
        </button>
      </div>

      {adding && (
        <div className="card">
          <AccountForm
            submitting={saving}
            submitLabel={t('clients_add')}
            submittingLabel={t('clients_saving')}
            onSubmit={addAccount}
          />
          {/* BRAND-1: выбор бренда на форме создания — только owner/admin/manager (тот же гейт, что рейтинг). */}
          {canEditRating && (
            <label className="client-brand-field" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <span className="muted" style={{ fontSize: '.85rem' }}>{t('brand_label')}</span>
              <select
                className="client-brand-select"
                value={newBrand}
                disabled={saving}
                aria-label={t('brand_label')}
                onChange={(e) => setNewBrand(brandKey(e.target.value))}
              >
                {BRAND_KEYS.map((key) => (
                  <option key={key} value={key}>{t(`brand_${key}`)}</option>
                ))}
              </select>
            </label>
          )}
          {saveError && <p className="error-msg">{t('client_save_failed')}</p>}
        </div>
      )}

      <div className="clients-filters" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          className="clients-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('clients_search')}
        />
        {/* BRAND-1: фильтр списка по бренду (Все | NW Build Pro | NW Custom Homes). */}
        <select
          className="clients-brand-filter"
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
      </div>

      {loading && <div className="card center muted">{t('loading')}</div>}
      {error && <p className="error-msg">{t('load_error')}</p>}

      {!loading && !error && accounts.length === 0 && <div className="card muted">{t('clients_empty')}</div>}
      {!loading && !error && accounts.length > 0 && filtered.length === 0 && <div className="card muted">{t('clients_search_empty')}</div>}

      {!loading && !error && filtered.length > 0 && (
        <div className="client-list">
          {filtered.map((account) => {
            const contact = [account.phone, account.email].filter(Boolean).join(' · ')
            const count = projectCounts.get(account.id) ?? 0
            return (
              <div key={account.id} className="card client-list-row">
                <button
                  type="button"
                  className="client-list-open"
                  onClick={() => openClient(account, { onUpdated: replaceAccount })}
                  style={{ display: 'grid', gap: 8, width: '100%', padding: 0, background: 'none', border: 'none', font: 'inherit', color: 'inherit', textAlign: 'left', cursor: 'pointer' }}
                >
                  <div className="client-list-main">
                    <div>
                      <div className="item-title" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        {account.name}
                        {/* BRAND-1: read-only пилюля бренда рядом с именем клиента. */}
                        <BrandBadge account={account} />
                      </div>
                      <div className="muted">{contact || t('client_no_contact')}</div>
                    </div>
                    <span className={`badge ${accountTypeTone(account.account_type)}`}>
                      {accountTypeLabel(t, account.account_type)}
                    </span>
                  </div>
                  <div className="muted">{count} {t('client_projects_count')}</div>
                  {/* CLI-1: read-only бейдж рейтинга — для не-менеджеров (внутри кнопки, это span) */}
                  {!canEditRating && <ClientRatingBadge account={account} />}
                </button>
                {/* CLI-1: менеджерам — редактор (звёзды + сложность), вне кнопки навигации */}
                {canEditRating && <ClientRatingEditor account={account} onUpdated={replaceAccount} />}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
