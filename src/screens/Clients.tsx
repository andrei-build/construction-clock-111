import { useEffect, useMemo, useState } from 'react'
import AccountForm from '../components/AccountForm'
import { useEntityDrawer } from '../components/EntityDrawer'
import { createAccount, getClientAccounts, getClientProjectSummaries } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import type { Account, AccountInput, ClientProjectSummary } from '../lib/types'

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

export default function Clients() {
  const { profile } = useAuth()
  const { t } = useI18n()
  const { openClient } = useEntityDrawer()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [projects, setProjects] = useState<ClientProjectSummary[]>([])
  const [search, setSearch] = useState('')
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
    if (!needle) return accounts
    return accounts.filter((account) => account.name.toLowerCase().includes(needle))
  }, [accounts, search])

  function replaceAccount(account: Account) {
    setAccounts((rows) => sortAccounts(rows.map((row) => (row.id === account.id ? account : row))))
  }

  async function addAccount(input: AccountInput) {
    if (!profile || saving) return
    setSaving(true)
    setSaveError(false)
    try {
      const created = await createAccount(profile, input)
      setAccounts((rows) => sortAccounts([...rows, created]))
      setAdding(false)
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
          {saveError && <p className="error-msg">{t('client_save_failed')}</p>}
        </div>
      )}

      <input
        className="clients-search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t('clients_search')}
      />

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
              <button
                type="button"
                key={account.id}
                className="card client-list-row"
                onClick={() => openClient(account, { onUpdated: replaceAccount })}
              >
                <div className="client-list-main">
                  <div>
                    <div className="item-title">{account.name}</div>
                    <div className="muted">{contact || t('client_no_contact')}</div>
                  </div>
                  <span className={`badge ${accountTypeTone(account.account_type)}`}>
                    {accountTypeLabel(t, account.account_type)}
                  </span>
                </div>
                <div className="muted">{count} {t('client_projects_count')}</div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
