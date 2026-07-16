import { useEffect, useState } from 'react'
import { useI18n } from '../../lib/i18n'
import {
  createProjectGrant,
  getAccountById,
  getClientAccessEnabled,
  getClientRating,
  getProjectClientMedia,
  getProjectGrants,
  revokeProjectGrant,
  setMediaClientVisible,
  updateClientAccessEnabled,
} from '../../lib/api'
import { isManagerWrite } from '../../lib/types'
import type { Account, AccountRating, ClientGrant, ClientMediaItem, Profile, Project } from '../../lib/types'

interface ClientTabProps {
  project: Project
  profile: Profile | null
}

// Ключи тумблеров гранта видимости — в порядке отображения. labelKey уже есть в i18n.
const GRANT_TOGGLES: { key: 'can_see_presence' | 'notify_travel' | 'notify_checkin' | 'notify_checkout'; labelKey: string }[] = [
  { key: 'can_see_presence', labelKey: 'hub_grant_can_see_presence' },
  { key: 'notify_travel', labelKey: 'hub_grant_notify_travel' },
  { key: 'notify_checkin', labelKey: 'hub_grant_notify_checkin' },
  { key: 'notify_checkout', labelKey: 'hub_grant_notify_checkout' },
]

type ToggleState = { can_see_presence: boolean; notify_travel: boolean; notify_checkin: boolean; notify_checkout: boolean }

const EMPTY_FORM: ToggleState = { can_see_presence: true, notify_travel: false, notify_checkin: false, notify_checkout: false }

export default function ClientTab({ project, profile }: ClientTabProps) {
  const { t } = useI18n()
  const clientId = project.client_account_id
  const canManage = profile ? isManagerWrite(profile.role) : false

  const [account, setAccount] = useState<Account | null>(null)
  const [rating, setRating] = useState<AccountRating | null>(null)
  const [grants, setGrants] = useState<ClientGrant[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  // CLIENT-MEDIA-1: медиа проекта под ручным управлением видимости + мастер-выключатель доступа.
  const [media, setMedia] = useState<ClientMediaItem[]>([])
  const [accessEnabled, setAccessEnabled] = useState(true)
  const [mediaBusy, setMediaBusy] = useState<string | null>(null)
  const [mediaError, setMediaError] = useState<string | null>(null)
  // CLI-1-полиш (в): owner-мастер-выключатель клиентского доступа.
  const [accessBusy, setAccessBusy] = useState(false)
  const [accessError, setAccessError] = useState<string | null>(null)

  const [form, setForm] = useState<ToggleState>(EMPTY_FORM)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [revokeError, setRevokeError] = useState<string | null>(null)

  useEffect(() => {
    if (!clientId) {
      setLoading(false)
      return
    }
    let mounted = true
    ;(async () => {
      setLoading(true)
      setLoadError(false)
      try {
        const [acc, rat, grantRows, mediaRows, access] = await Promise.all([
          getAccountById(clientId),
          getClientRating(clientId),
          getProjectGrants(project.id),
          getProjectClientMedia(project.id),
          getClientAccessEnabled(clientId),
        ])
        if (!mounted) return
        setAccount(acc)
        setRating(rat)
        setGrants(grantRows)
        setMedia(mediaRows)
        setAccessEnabled(access)
      } catch {
        if (mounted) setLoadError(true)
      } finally {
        if (mounted) setLoading(false)
      }
    })()
    return () => { mounted = false }
  }, [clientId, project.id])

  const createGrant = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!profile || !clientId || busy) return
    setBusy(true)
    setFormError(null)
    try {
      const created = await createProjectGrant(profile, project.id, clientId, {
        ...form,
        channel: 'portal',
        note: note.trim() || null,
      })
      setGrants((rows) => [created, ...rows])
      setForm(EMPTY_FORM)
      setNote('')
    } catch {
      setFormError('hub_grant_add_failed')
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (grant: ClientGrant) => {
    if (!profile || busy) return
    setBusy(true)
    setRevokeError(null)
    try {
      await revokeProjectGrant(profile, grant.id)
      setGrants((rows) => rows.filter((row) => row.id !== grant.id))
    } catch {
      setRevokeError('hub_grant_revoke_failed')
    } finally {
      setBusy(false)
    }
  }

  // CLIENT-MEDIA-1: ручной show/hide одного элемента — flip media.client_visible.
  const toggleMedia = async (item: ClientMediaItem) => {
    if (!profile || !canManage || !accessEnabled || mediaBusy) return
    const next = !item.client_visible
    setMediaBusy(item.id)
    setMediaError(null)
    try {
      await setMediaClientVisible(profile, item.id, next)
      setMedia((rows) => rows.map((r) => (r.id === item.id ? { ...r, client_visible: next } : r)))
    } catch {
      setMediaError('client_visible_error')
    } finally {
      setMediaBusy(null)
    }
  }

  // CLI-1-полиш (в): мастер-выключатель доступа — только owner. Пишем client_access_enabled,
  // затем рефетчим фактическое состояние (сервер — источник истины).
  const toggleAccess = async (next: boolean) => {
    if (!profile || !clientId || profile.role !== 'owner' || accessBusy) return
    setAccessBusy(true)
    setAccessError(null)
    try {
      await updateClientAccessEnabled(profile, clientId, next)
      const fresh = await getClientAccessEnabled(clientId)
      setAccessEnabled(fresh)
    } catch {
      setAccessError('hub_client_access_toggle_failed')
    } finally {
      setAccessBusy(false)
    }
  }

  // Клиент не привязан к проекту — карточку и гранты не показываем.
  if (!clientId) {
    return (
      <section className="hub-tab-panel hub-client">
        <div className="card muted">{t('hub_client_none')}</div>
      </section>
    )
  }

  if (loading) {
    return (
      <section className="hub-tab-panel hub-client">
        <div className="card center muted">{t('loading')}</div>
      </section>
    )
  }

  if (loadError) {
    return (
      <section className="hub-tab-panel hub-client">
        <p className="error-msg">{t('hub_client_load_error')}</p>
      </section>
    )
  }

  const ratingValue = rating?.client_rating ?? null
  const starRating = rating?.rating ?? null
  const difficulty = rating?.difficulty ?? null
  const isOwner = profile?.role === 'owner'

  return (
    <section className="hub-tab-panel hub-client">
      {/* Карточка клиента */}
      <div className="card hub-client-card">
        {account ? (
          <>
            <div className="hub-client-head">
              <span className="item-title">{account.name}</span>
              {account.account_type && (
                <span className="badge grey">{t(`account_type_${account.account_type}`)}</span>
              )}
            </div>
            <div className="hub-client-contacts">
              {account.phone && <span className="muted">{account.phone}</span>}
              {account.email && <span className="muted">{account.email}</span>}
              {!account.phone && !account.email && <span className="muted">—</span>}
            </div>
          </>
        ) : (
          <p className="muted">{t('hub_client_missing')}</p>
        )}

        <div className="hub-client-rating">
          <span className="muted">{t('hub_client_rating')}</span>
          {ratingValue ? (
            <span className="hub-client-rating-value">
              <span className={`hub-client-dot hub-client-dot-${ratingValue}`} aria-hidden="true" />
              <span>{t(`hub_rating_${ratingValue}`)}</span>
            </span>
          ) : (
            <span className="hub-client-rating-value">
              <span className="badge grey">{t('hub_client_no_rating')}</span>
            </span>
          )}
          {/* CLI-1-полиш (б): звёзды (accounts.rating 1..5) + сложность (accounts.difficulty) */}
          {starRating != null ? (
            <span className="hub-client-stars" aria-label={t('client_rating_set').replace('{n}', String(starRating))}>
              {[1, 2, 3, 4, 5].map((n) => (
                <span key={n} className={n <= starRating ? 'hub-star on' : 'hub-star'} aria-hidden="true">
                  {n <= starRating ? '★' : '☆'}
                </span>
              ))}
            </span>
          ) : (
            <span className="badge grey">★ {t('hub_client_stars_unset')}</span>
          )}
          {difficulty && (
            <span className={`badge hub-difficulty hub-difficulty-${difficulty}`}>
              {t('client_difficulty_label')}: {t(`client_difficulty_${difficulty}`)}
            </span>
          )}
        </div>
        {ratingValue && rating?.rating_note && <p className="muted hub-client-rating-note">{rating.rating_note}</p>}
        {!ratingValue && <p className="muted hub-client-rating-note">{t('hub_client_no_rating_explain')}</p>}
      </div>

      {/* Активные гранты видимости */}
      <div className="card">
        <h2>{t('hub_client_notifications')}</h2>
        {revokeError && <p className="error-msg">{t(revokeError)}</p>}
        {grants.length === 0 ? (
          <p className="muted">{t('hub_client_grants_empty')}</p>
        ) : (
          <div className="hub-client-grant-list">
            {grants.map((grant) => {
              const active = GRANT_TOGGLES.filter((toggle) => grant[toggle.key])
              return (
                <div className="hub-client-grant" key={grant.id}>
                  <div className="hub-client-grant-info">
                    <div className="hub-client-grant-flags">
                      {active.length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        active.map((toggle) => (
                          <span className="badge blue" key={toggle.key}>{t(toggle.labelKey)}</span>
                        ))
                      )}
                    </div>
                    <div className="muted hub-client-grant-meta">
                      <span>{t('hub_grant_channel')}: {grant.channel}</span>
                      <span> · {new Date(grant.created_at).toLocaleDateString()}</span>
                    </div>
                    {grant.note && <div className="hub-client-grant-note">{grant.note}</div>}
                  </div>
                  {canManage && (
                    <button
                      className="btn ghost small"
                      type="button"
                      disabled={busy}
                      onClick={() => revoke(grant)}
                    >
                      {t('hub_grant_revoke')}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* CLI-1-полиш (в): owner-мастер-выключатель «Клиент подключён / отключён полностью» */}
      {isOwner && (
        <div className={`card hub-client-access-master${accessEnabled ? '' : ' muted'}`}>
          <label className="check-row">
            <input
              type="checkbox"
              checked={accessEnabled}
              disabled={accessBusy}
              onChange={(e) => toggleAccess(e.target.checked)}
            />
            <span>{t('hub_client_access_master')}</span>
          </label>
          <p className="muted hub-client-access-hint">
            {accessEnabled ? t('hub_client_access_master_on') : t('hub_client_access_master_off')}
          </p>
          {accessError && <p className="error-msg">{t(accessError)}</p>}
        </div>
      )}

      {/* CLIENT-MEDIA-1: «Видно клиенту» — превью фото/видео проекта с ручным show/hide */}
      <div className={`card${accessEnabled ? '' : ' muted'}`}>
        <h2>{t('client_visible_block')}</h2>
        {!accessEnabled && <p className="muted">{t('client_access_disabled')}</p>}
        {mediaError && <p className="error-msg">{t(mediaError)}</p>}
        {media.length === 0 ? (
          <p className="muted">{t('client_visible_empty')}</p>
        ) : (
          <div className="task-attach-thumbs">
            {media.map((item) => (
              <div key={item.id} className="hub-client-media-item" style={{ opacity: item.client_visible ? 1 : 0.5 }}>
                {item.url ? (
                  item.media_type === 'video' ? (
                    <video className="task-attach-thumb" src={item.url} controls preload="metadata" />
                  ) : (
                    <a href={item.url} target="_blank" rel="noreferrer">
                      <img className="task-attach-thumb" src={item.url} alt={item.filename ?? ''} />
                    </a>
                  )
                ) : (
                  <div className="task-attach-thumb center muted">—</div>
                )}
                {canManage && (
                  <button
                    className="btn ghost small"
                    type="button"
                    disabled={!accessEnabled || mediaBusy === item.id}
                    onClick={() => toggleMedia(item)}
                  >
                    {item.client_visible ? t('client_visible_hide') : t('client_visible_show')}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Форма создания гранта */}
      {canManage && (
        <form className="card hub-client-grant-form" onSubmit={createGrant}>
          <h2>{t('hub_grant_new')}</h2>
          <div className="hub-client-toggles">
            {GRANT_TOGGLES.map((toggle) => (
              <label className="check-row" key={toggle.key}>
                <input
                  type="checkbox"
                  checked={form[toggle.key]}
                  disabled={busy}
                  onChange={(e) => setForm((prev) => ({ ...prev, [toggle.key]: e.target.checked }))}
                />
                <span>{t(toggle.labelKey)}</span>
              </label>
            ))}
          </div>
          <label className="muted hub-client-note-label">{t('hub_grant_note')}</label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder={t('hub_grant_note_placeholder')}
          />
          {formError && <p className="error-msg">{t(formError)}</p>}
          <button className="btn small" disabled={busy}>{busy ? t('saving') : t('hub_grant_add')}</button>
        </form>
      )}
    </section>
  )
}
