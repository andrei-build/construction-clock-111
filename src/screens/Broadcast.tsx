import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import VoiceMic from '../components/VoiceMic'
import { broadcastClients, getDocumentAccounts } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import type { Account } from '../lib/types'

// BROADCAST-1: экран «Рассылка» — владелец пишет письмо всем/по бренду/выбранным клиентам и
// шлёт его через edge `broadcast-clients`. OWNER-ONLY: не-владельцу — дружелюбный отказ (не падаем),
// как в OwnerSettings; сам маршрут дополнительно гейтит App.tsx менеджерским предикатом.
type Audience = 'all' | 'brand' | 'selected'
type BrandKey = 'nw_build_pro' | 'nw_custom_homes'

// Нормализуем бренд аккаунта к одному из двух известных значений (дефолт — 'nw_build_pro'),
// как это делает Clients.tsx (BRAND-1).
function brandKey(value: string | null | undefined): BrandKey {
  return value === 'nw_custom_homes' ? 'nw_custom_homes' : 'nw_build_pro'
}

export default function Broadcast() {
  const { profile } = useAuth()
  const { t, lang } = useI18n()
  const isOwner = profile?.role === 'owner'

  const [accounts, setAccounts] = useState<Account[]>([])
  const [audience, setAudience] = useState<Audience>('all')
  const [brand, setBrand] = useState<BrandKey>('nw_build_pro')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<{ sent: number; total: number; failures: number } | null>(null)
  const [errorKey, setErrorKey] = useState<string | null>(null)

  useEffect(() => {
    if (!isOwner) return
    let mounted = true
    getDocumentAccounts().then((rows) => { if (mounted) setAccounts(rows) })
    return () => { mounted = false }
  }, [isOwner])

  // Аккаунты выбранного бренда — их id уходят в account_ids при режиме «Только бренд».
  const brandIds = useMemo(
    () => accounts.filter((a) => brandKey(a.brand) === brand).map((a) => a.id),
    [accounts, brand],
  )

  if (!isOwner) {
    // Дружелюбный отказ — не падаем, показываем понятную заметку (как OwnerSettings).
    return (
      <div className="screen">
        <h1>📣 {t('broadcast_title')}</h1>
        <div className="card muted">{t('broadcast_owner_only')}</div>
      </div>
    )
  }

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // «Все» -> undefined (edge шлёт всем). «Бренд»/«Выбранные» -> массив id.
  const audienceIds = (): string[] | undefined => {
    if (audience === 'all') return undefined
    if (audience === 'brand') return brandIds
    return [...selectedIds]
  }

  const targetCount = audience === 'all'
    ? accounts.length
    : audience === 'brand' ? brandIds.length : selectedIds.size
  const emptySelection = audience !== 'all' && targetCount === 0
  const canSend = subject.trim().length > 0 && message.trim().length > 0 && !sending && !emptySelection

  const send = async () => {
    if (!canSend) return
    setSending(true)
    setResult(null)
    setErrorKey(null)
    try {
      const res = await broadcastClients(subject.trim(), message.trim(), audienceIds())
      if (res.ok) {
        setResult({ sent: res.sent, total: res.total, failures: res.failures })
        setSubject('')
        setMessage('')
      } else {
        setErrorKey(
          res.error === 'only_owner_can_broadcast' ? 'broadcast_err_only_owner'
            : res.error === 'subject_and_message_required' ? 'broadcast_err_subject_message_required'
              : 'broadcast_err_generic',
        )
      }
    } catch {
      setErrorKey('broadcast_err_generic')
    } finally {
      setSending(false)
    }
  }

  const resultText = result
    ? t('broadcast_result').replace('{sent}', String(result.sent)).replace('{total}', String(result.total))
    : ''
  const failuresText = result && result.failures > 0
    ? t('broadcast_failures').replace('{count}', String(result.failures))
    : ''

  return (
    <div className="screen">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>📣 {t('broadcast_title')}</h1>
        <Link to="/clients" className="btn ghost small">{t('clients')}</Link>
      </div>

      <div className="card">
        <label>{t('broadcast_subject')}</label>
        <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} />

        <div className="message-body-label">
          <label>{t('broadcast_message')}</label>
          <VoiceMic
            lang={lang}
            title={t('voice_input')}
            onResult={(text) => setMessage((prev) => (prev ? `${prev} ${text}` : text))}
          />
        </div>
        <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={5} />

        <label>{t('broadcast_audience')}</label>
        <select value={audience} onChange={(e) => setAudience(e.target.value as Audience)}>
          <option value="all">{t('broadcast_audience_all')}</option>
          <option value="brand">{t('broadcast_audience_brand')}</option>
          <option value="selected">{t('broadcast_audience_selected')}</option>
        </select>

        {audience === 'brand' && (
          <select
            value={brand}
            onChange={(e) => setBrand(e.target.value as BrandKey)}
            aria-label={t('broadcast_audience_brand')}
            style={{ marginTop: 8 }}
          >
            <option value="nw_build_pro">{t('brand_nw_build_pro')}</option>
            <option value="nw_custom_homes">{t('brand_nw_custom_homes')}</option>
          </select>
        )}

        {audience === 'selected' && (
          <div className="broadcast-client-list" style={{ marginTop: 8, display: 'grid', gap: 6 }}>
            {accounts.map((a) => (
              <label key={a.id} className="broadcast-client-row" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={selectedIds.has(a.id)} onChange={() => toggleSelected(a.id)} />
                <span>{a.name}</span>
                <span className={`badge ${brandKey(a.brand) === 'nw_custom_homes' ? 'blue' : 'green'}`}>
                  {t(`brand_${brandKey(a.brand)}`)}
                </span>
              </label>
            ))}
          </div>
        )}

        <button type="button" className="btn" disabled={!canSend} onClick={send} style={{ marginTop: 12 }}>
          {sending ? t('broadcast_sending') : t('broadcast_send')}
        </button>

        {emptySelection && <p className="muted">{t('broadcast_empty_selection')}</p>}
        {result && <p className="ok-msg">{resultText}{failuresText ? ` · ${failuresText}` : ''}</p>}
        {errorKey && <p className="error-msg">{t(errorKey)}</p>}
      </div>
    </div>
  )
}
