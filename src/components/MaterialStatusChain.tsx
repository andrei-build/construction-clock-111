import { useRef } from 'react'
import { useI18n } from '../lib/i18n'
import type { MaterialStatusAction } from '../lib/api'
import type { Task } from '../lib/types'

interface MaterialStatusChainProps {
  task: Task
  peopleById?: Map<string, string>
  busy?: boolean
  compact?: boolean
  onStatusChange?: (task: Task, action: MaterialStatusAction) => Promise<void> | void
}

const localeByLang = {
  ru: 'ru-RU',
  en: 'en-US',
  es: 'es-ES',
} as const

export function isMaterialFlowTask(task: Task) {
  return task.task_type === 'material' || task.task_type === 'delivery'
}

function actorName(id: string | null | undefined, peopleById?: Map<string, string>) {
  if (!id) return ''
  return peopleById?.get(id) ?? id.slice(0, 8)
}

function formatMoment(iso: string | null | undefined, locale: string) {
  if (!iso) return ''
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))
}

function stepMeta(
  actorId: string | null | undefined,
  iso: string | null | undefined,
  peopleById: Map<string, string> | undefined,
  locale: string,
  waiting: string,
) {
  if (!iso) return waiting
  return [actorName(actorId, peopleById), formatMoment(iso, locale)].filter(Boolean).join(', ')
}

export default function MaterialStatusChain({
  task,
  peopleById,
  busy = false,
  compact = false,
  onStatusChange,
}: MaterialStatusChainProps) {
  const { t, lang } = useI18n()
  const locale = localeByLang[lang]
  const picked = Boolean(task.picked_up_at)
  const delivered = Boolean(task.delivered_at)
  const canAct = Boolean(onStatusChange)
  const longPressTimer = useRef<number | null>(null)
  const longPressFired = useRef(false)

  const run = (action: MaterialStatusAction) => {
    if (!onStatusChange || busy) return
    void onStatusChange(task, action)
  }

  const clearLongPress = () => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }

  const startUndoLongPress = () => {
    if (!picked || delivered || busy || !canAct) return
    clearLongPress()
    longPressFired.current = false
    longPressTimer.current = window.setTimeout(() => {
      longPressFired.current = true
      run('undo_picked_up')
    }, 650)
  }

  const clickPickup = () => {
    if (longPressFired.current) {
      longPressFired.current = false
      return
    }
    if (!picked) run('picked_up')
    else if (!delivered) run('undo_picked_up')
  }

  const pickedMeta = stepMeta(task.picked_up_by, task.picked_up_at, peopleById, locale, t('material_status_waiting'))
  const deliveredMeta = stepMeta(task.delivered_by, task.delivered_at, peopleById, locale, t('material_status_waiting'))

  return (
    <div className={`material-status-chain ${compact ? 'compact' : ''}`}>
      <div className="material-steps" aria-label={t('material_status_chain')}>
        <div className="material-step complete">
          <span className="material-step-label">{t('material_status_ordered')}</span>
        </div>
        <span className="material-step-arrow" aria-hidden="true">→</span>
        <div className={`material-step ${picked ? 'complete' : 'pending'}`}>
          <span className="material-step-label">{t('material_status_picked_up')}</span>
          <span className="material-step-meta">{pickedMeta}</span>
        </div>
        <span className="material-step-arrow" aria-hidden="true">→</span>
        <div className={`material-step ${delivered ? 'complete' : 'pending'}`}>
          <span className="material-step-label">{t('material_status_delivered')}</span>
          <span className="material-step-meta">{deliveredMeta}</span>
        </div>
      </div>

      <div className="material-actions">
        <button
          type="button"
          className={`material-action ${picked ? 'complete' : ''}`}
          disabled={busy || delivered || !canAct}
          title={picked && !delivered ? t('material_undo_pickup_hint') : undefined}
          onClick={clickPickup}
          onPointerDown={startUndoLongPress}
          onPointerUp={clearLongPress}
          onPointerCancel={clearLongPress}
          onPointerLeave={clearLongPress}
          onContextMenu={(e) => {
            if (!picked || delivered || busy || !canAct) return
            e.preventDefault()
            run('undo_picked_up')
          }}
        >
          <span className="material-action-check" aria-hidden="true">{picked ? '✓' : '○'}</span>
          <span>{t('material_action_pick_up')}</span>
        </button>
        <button
          type="button"
          className={`material-action ${delivered ? 'complete' : ''}`}
          disabled={busy || !picked || delivered || !canAct}
          onClick={() => run('delivered')}
        >
          <span className="material-action-check" aria-hidden="true">{delivered ? '✓' : '○'}</span>
          <span>{t('material_action_deliver')}</span>
        </button>
      </div>
    </div>
  )
}
