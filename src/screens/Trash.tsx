import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { getTrashItems, purgeEntity, restoreEntity } from '../lib/api'
import type { PurgeEntityType } from '../lib/api'
import type { ArchiveTable, TrashItem, TrashKind } from '../lib/types'

const localeByLang = {
  ru: 'ru-RU',
  en: 'en-US',
  es: 'es-ES',
} as const

const KIND_LABEL: Record<TrashKind, string> = {
  project: 'trash_kind_project',
  profile: 'trash_kind_profile',
  task: 'trash_kind_task',
  receipt: 'trash_kind_receipt',
}

const KIND_ICON: Record<TrashKind, string> = {
  project: '📁',
  profile: '👤',
  task: '✅',
  receipt: '🧾',
}

const PURGE_ENTITY_TYPE: Partial<Record<ArchiveTable, PurgeEntityType>> = {
  tasks: 'task',
  media: 'media',
  project_expenses: 'project_expense',
}

function purgeErrorKey(error: unknown): string {
  const message = String((error as { message?: unknown } | null)?.message ?? '')
  if (message === 'only_owner_can_purge') return 'purge_err_only_owner'
  if (message === 'not_in_trash') return 'purge_err_not_in_trash'
  if (message === 'unsupported_entity_type') return 'purge_err_unsupported'
  if (message === 'purge_blocked_by_references') return 'purge_err_blocked'
  if (message === 'no_profile') return 'purge_err_no_profile'
  return 'purge_err_generic'
}

// ARCH-1 «Корзина»: мягко удалённые сущности (deleted_at IS NOT NULL) → «Восстановить» (очистка deleted_at)
// или «Удалить навсегда» через owner-only RPC purge_entity. Маршрут гейтится менеджером в App.tsx.
export default function Trash() {
  const { profile } = useAuth()
  const { t, lang } = useI18n()
  const isOwner = profile?.role === 'owner'

  const [items, setItems] = useState<TrashItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [restoreError, setRestoreError] = useState(false)
  const [purgeMsg, setPurgeMsg] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    async function load() {
      setLoading(true)
      setError(false)
      try {
        const rows = await getTrashItems()
        if (mounted) setItems(rows)
      } catch {
        if (mounted) { setItems([]); setError(true) }
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => { mounted = false }
  }, [profile?.id])

  const formatDate = (iso: string) =>
    new Intl.DateTimeFormat(localeByLang[lang], { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))

  async function handleRestore(item: TrashItem) {
    if (!profile || busyId) return
    setBusyId(item.id)
    setRestoreError(false)
    setPurgeMsg(null)
    try {
      await restoreEntity(profile, item.table, item.id)
      setItems((rows) => rows.filter((r) => !(r.id === item.id && r.kind === item.kind)))
    } catch {
      setRestoreError(true)
    } finally {
      setBusyId(null)
    }
  }

  async function handlePurge(item: TrashItem, entityType: PurgeEntityType) {
    if (!profile || busyId || !isOwner) return
    if (typeof window !== 'undefined') {
      if (!window.confirm(t('purge_confirm1'))) return
      if (!window.confirm(t('purge_confirm2'))) return
    }
    setBusyId(item.id)
    setRestoreError(false)
    setPurgeMsg(null)
    try {
      await purgeEntity(entityType, item.id)
      setItems((rows) => rows.filter((r) => !(r.id === item.id && r.kind === item.kind)))
      setPurgeMsg('purge_success')
    } catch (err) {
      setPurgeMsg(purgeErrorKey(err))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="screen">
      <div className="archive-head">
        <div>
          <div className="archive-eyebrow">🗑️ {t('trash_title')}</div>
          <h1>{t('trash_title')}</h1>
        </div>
        <Link to="/archive" className="btn ghost small">{t('trash_open_archive')}</Link>
      </div>
      <p className="muted" style={{ marginTop: -8 }}>{t('trash_desc')}</p>

      {loading && <div className="card center muted">{t('loading')}</div>}
      {error && <p className="error-msg">{t('load_error')}</p>}
      {restoreError && <p className="error-msg">{t('restore_failed')}</p>}
      {purgeMsg && <p className={purgeMsg === 'purge_success' ? 'ok-msg' : 'error-msg'}>{t(purgeMsg)}</p>}
      {!loading && !error && (
        <p className="muted" style={{ fontSize: 12 }}>{items.length} {t('trash_items')}</p>
      )}

      {!loading && !error && items.length === 0 && (
        <div className="card center muted">🧹 {t('trash_empty')}</div>
      )}

      {!loading && !error && items.map((item) => {
        const purgeType = PURGE_ENTITY_TYPE[item.table]
        const isBusy = busyId === item.id
        return (
          <div key={`${item.kind}-${item.id}`} className="card">
            <div className="row">
              <div>
                <span className="item-title">{KIND_ICON[item.kind]} {item.name}</span>
                <div className="muted" style={{ fontSize: 12 }}>
                  <span className="badge">{t(KIND_LABEL[item.kind])}</span>
                  {' '}{t('archive_deleted_on')}: {formatDate(item.deleted_at)}
                </div>
              </div>
            </div>
            <div className="project-nav-actions">
              <button
                type="button"
                className="btn small"
                disabled={isBusy}
                onClick={() => handleRestore(item)}
              >
                {isBusy ? '…' : t('restore')}
              </button>
              {isOwner && purgeType && (
                <button
                  type="button"
                  className="btn small red"
                  disabled={isBusy}
                  onClick={() => handlePurge(item, purgeType)}
                >
                  {isBusy ? '…' : t('purge_forever')}
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
