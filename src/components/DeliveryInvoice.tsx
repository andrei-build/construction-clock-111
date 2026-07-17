import { useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../lib/i18n'
import {
  getDeliveryItems,
  addDeliveryItem,
  setDeliveryItemStatus,
  deleteDeliveryItem,
  subscribeToDeliveryItems,
  type DeliveryItemStatus,
} from '../lib/api'
import { isManagerWrite } from '../lib/types'
import type { DeliveryItem, Profile, Task } from '../lib/types'

// DELIVERY-2: накладная доставки как МОДАЛ (не роут — App.tsx не трогаем). Список позиций
// delivery_items с построчным вводом «как в Check Time» (Enter/«+» → сразу новая пустая строка),
// отметками водителей (Купил / Есть у меня — завезу / Привезено) с «кто + когда» и РЕАЛТАЙМ-
// подпиской: два водителя в разных магазинах видят отметки друг друга сразу. Отписка при закрытии.

interface DeliveryInvoiceProps {
  task: Task
  profile: Profile | null
  team: Profile[]
  onClose: () => void
  // Живой прогресс наверх (карточка списка/КЦ показывает «N/M позиций» без перезагрузки).
  onProgressChange?: (taskId: string, progress: { total: number; delivered: number }) => void
}

// Порядок статусов позиции — детализация ВНУТРИ доставки (не путать с цепочкой всей доставки).
const STATUS_ORDER: DeliveryItemStatus[] = ['bought', 'have', 'delivered']
const STATUS_BADGE: Record<DeliveryItemStatus, string> = {
  needed: 'badge grey',
  bought: 'badge amber',
  have: 'badge blue',
  delivered: 'badge green',
}

function fmtWhen(iso: string | null | undefined) {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString()
}

export default function DeliveryInvoice({ task, profile, team, onClose, onProgressChange }: DeliveryInvoiceProps) {
  const { t } = useI18n()
  const [items, setItems] = useState<DeliveryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rowBusy, setRowBusy] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  // Построчный ввод: одна всегда-присутствующая пустая строка (title + details).
  const [dTitle, setDTitle] = useState('')
  const [dDetails, setDDetails] = useState('')
  const [adding, setAdding] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)

  const nameById = useMemo(() => new Map(team.map((p) => [p.id, p.name])), [team])
  const name = (id: string | null | undefined) => (id ? nameById.get(id) ?? '—' : '—')

  // Все активные роли КРОМЕ client могут добавлять/отмечать (RLS delivery_items_members).
  const canWrite = Boolean(profile && profile.role !== 'client')
  // Удалять — менеджер+ или создатель (позиции либо самой доставки).
  const canDelete = (item: DeliveryItem) =>
    Boolean(profile && (isManagerWrite(profile.role) || item.created_by === profile.id || task.created_by === profile.id))

  const load = async () => {
    try {
      const rows = await getDeliveryItems(task.id)
      setItems(rows)
      setLoadError(false)
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id])

  // Реалтайм по позициям этой доставки — отписка при размонтировании (закрытии модала).
  useEffect(() => {
    return subscribeToDeliveryItems(task.id, () => { void load() }, `delivery:${task.id}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id])

  // Живой прогресс наверх при любом изменении списка. Пока идёт первичная загрузка — не шлём
  // пустое {0,0}, иначе бейдж «N/M» на карточке моргнёт в ноль до прихода позиций.
  useEffect(() => {
    if (!onProgressChange || loading) return
    const delivered = items.filter((i) => i.status === 'delivered').length
    onProgressChange(task.id, { total: items.length, delivered })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, loading])

  const addItem = async () => {
    if (!profile || adding) return
    const title = dTitle.trim()
    if (!title) return
    setAdding(true)
    setError(null)
    try {
      const created = await addDeliveryItem(profile, task, {
        title,
        details: dDetails.trim() || null,
        position: items.length,
      })
      setItems((rows) => [...rows, created])
      // Как в Check Time: очищаем строку и сразу возвращаем фокус — можно бить позиции подряд.
      setDTitle('')
      setDDetails('')
      titleRef.current?.focus()
    } catch {
      setError('delivery_add_error')
    } finally {
      setAdding(false)
    }
  }

  const onDraftKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void addItem()
    }
  }

  const mark = async (item: DeliveryItem, status: DeliveryItemStatus) => {
    if (!profile || rowBusy) return
    // Повторный клик по активной отметке — сброс в needed (undo).
    const next: DeliveryItemStatus = item.status === status ? 'needed' : status
    setRowBusy(item.id)
    setError(null)
    try {
      const updated = await setDeliveryItemStatus(profile, item, next)
      setItems((rows) => rows.map((r) => (r.id === item.id ? updated : r)))
    } catch {
      setError('delivery_mark_error')
    } finally {
      setRowBusy(null)
    }
  }

  const removeItem = async (item: DeliveryItem) => {
    if (rowBusy) return
    setRowBusy(item.id)
    setError(null)
    try {
      await deleteDeliveryItem(item.id)
      setItems((rows) => rows.filter((r) => r.id !== item.id))
      setConfirmDeleteId(null)
    } catch {
      setError('delivery_delete_error')
    } finally {
      setRowBusy(null)
    }
  }

  const delivered = items.filter((i) => i.status === 'delivered').length

  return (
    <div className="confirm-backdrop delivery-backdrop" onClick={onClose}>
      <div className="card delivery-invoice" onClick={(e) => e.stopPropagation()}>
        <div className="row delivery-head" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h2 style={{ margin: 0 }}>🚚 {t('delivery_invoice_title')}</h2>
            <div className="muted delivery-sub">{task.title}</div>
          </div>
          <button className="btn ghost small" onClick={onClose} aria-label={t('close')}>✕</button>
        </div>

        <div className="delivery-progress muted">
          {t('delivery_progress_label')}: <b>{delivered}/{items.length}</b> {t('delivery_positions')}
        </div>

        {error && <p className="error-msg">{t(error)}</p>}
        {loading && <div className="center muted">{t('loading')}</div>}
        {loadError && <p className="error-msg">{t('delivery_load_error')}</p>}

        {!loading && !loadError && (
          <div className="delivery-items">
            {items.length === 0 && <p className="muted">{t('delivery_empty')}</p>}
            {items.map((item) => (
              <div key={item.id} className="delivery-item">
                <div className="delivery-item-main">
                  <div className="delivery-item-title">
                    <span className="item-title">{item.title}</span>
                    <span className={STATUS_BADGE[item.status]}>{t(`delivery_status_${item.status}`)}</span>
                  </div>
                  {item.details && <div className="muted delivery-item-details">{item.details}</div>}
                  {item.status !== 'needed' && (
                    <div className="muted delivery-item-meta">
                      {item.status === 'have' && item.claimed_by
                        ? `${t('delivery_claimed_by')}: ${name(item.claimed_by)}`
                        : `${name(item.updated_by)}`}
                      {item.updated_at ? ` · ${fmtWhen(item.updated_at)}` : ''}
                    </div>
                  )}
                </div>

                {canWrite && (
                  <div className="delivery-item-actions">
                    {STATUS_ORDER.map((st) => (
                      <button
                        key={st}
                        type="button"
                        className={`btn small ${item.status === st ? '' : 'ghost'}`}
                        disabled={rowBusy === item.id}
                        onClick={() => mark(item, st)}
                      >
                        {item.status === st ? '✓ ' : ''}{t(`delivery_action_${st}`)}
                      </button>
                    ))}
                    {canDelete(item) && (
                      confirmDeleteId === item.id ? (
                        <>
                          <button className="btn red small" disabled={rowBusy === item.id} onClick={() => removeItem(item)}>{t('remove')}</button>
                          <button className="btn ghost small" onClick={() => setConfirmDeleteId(null)}>{t('cancel')}</button>
                        </>
                      ) : (
                        <button className="btn ghost small delivery-del" disabled={rowBusy === item.id} onClick={() => setConfirmDeleteId(item.id)} aria-label={t('delivery_delete')}>🗑</button>
                      )
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {!loading && canWrite && (
          <div className="delivery-add-row">
            <input
              ref={titleRef}
              value={dTitle}
              onChange={(e) => setDTitle(e.target.value)}
              onKeyDown={onDraftKeyDown}
              placeholder={t('delivery_item_title_ph')}
              className="delivery-add-title"
            />
            <input
              value={dDetails}
              onChange={(e) => setDDetails(e.target.value)}
              onKeyDown={onDraftKeyDown}
              placeholder={t('delivery_item_details_ph')}
              className="delivery-add-details"
            />
            <button className="btn small delivery-add-btn" type="button" disabled={adding || !dTitle.trim()} onClick={addItem} aria-label={t('delivery_add')}>+</button>
          </div>
        )}
        {!loading && canWrite && <p className="muted delivery-add-hint">{t('delivery_add_hint')}</p>}
      </div>
    </div>
  )
}
