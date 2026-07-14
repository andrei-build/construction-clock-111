import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { getTrashItems, restoreEntity } from '../lib/api'
import type { TrashItem, TrashKind } from '../lib/types'

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

// ARCH-1 «Корзина»: мягко удалённые сущности (deleted_at IS NOT NULL) → «Восстановить» (очистка deleted_at)
// или «Удалить навсегда» (owner-only). Жёсткого удаления на фронте нет (см. BACKEND REQUEST в api.ts),
// поэтому кнопка purge показывается только владельцу и отключена. Маршрут гейтится менеджером в App.tsx.
export default function Trash() {
  const { profile } = useAuth()
  const { t, lang } = useI18n()
  const isOwner = profile?.role === 'owner'

  const [items, setItems] = useState<TrashItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [restoreError, setRestoreError] = useState(false)

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
    try {
      await restoreEntity(profile, item.table, item.id)
      setItems((rows) => rows.filter((r) => !(r.id === item.id && r.kind === item.kind)))
    } catch {
      setRestoreError(true)
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
      {!loading && !error && (
        <p className="muted" style={{ fontSize: 12 }}>{items.length} {t('trash_items')}</p>
      )}

      {!loading && !error && items.length === 0 && (
        <div className="card center muted">🧹 {t('trash_empty')}</div>
      )}

      {!loading && !error && items.map((item) => (
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
              disabled={busyId === item.id}
              onClick={() => handleRestore(item)}
            >
              {busyId === item.id ? '…' : t('restore')}
            </button>
            {/* «Удалить навсегда» — OWNER-ONLY (DNA). Жёсткого удаления на фронте нет, кнопка отключена.
                BACKEND REQUEST: purge_entity(table, id) под owner-гейтом — см. src/lib/api.ts. */}
            {isOwner && (
              <button
                type="button"
                className="btn small red"
                disabled
                title={t('trash_purge_unavailable')}
              >
                {t('trash_delete_permanently')}
              </button>
            )}
          </div>
          {isOwner && <div className="muted trash-purge-note">{t('trash_purge_unavailable')}</div>}
        </div>
      ))}
    </div>
  )
}
