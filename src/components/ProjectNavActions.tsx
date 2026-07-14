import { useState } from 'react'
import { useI18n } from '../lib/i18n'
import { startProjectTravel } from '../lib/api'
import type { Profile, Project } from '../lib/types'
import {
  getNavigationDestination,
  buildAddressCopyText,
  buildGoogleMapsUrl,
  buildAppleMapsUrl,
  buildGeoNavigationUrl,
  buildNavigationShareText,
  buildCoordinateCopyText,
  normalizeAddressForCopy,
} from '../lib/project-navigation'

interface ProjectNavActionsProps {
  // TRAVEL-2: полный Project + текущий Profile нужны, чтобы «В путь» реально писал travel.started
  // и дёргал notifyTravelStarted (иначе клиент никогда не уведомляется). Профиль может быть null
  // до загрузки авторизации — тогда навигация всё равно открывается, просто без записи события.
  project: Project
  profile: Profile | null
  projectName: string
  address?: string | null
  lat?: number | string | null
  lng?: number | string | null
}

// TRAVEL-2: одна кнопка «В путь» = реальный «Let's go». Клик:
//   1) fire-and-forget startProjectTravel → travel.started + notifyTravelStarted (edge travel-notify);
//      ошибка НИКОГДА не блокирует навигацию (best-effort).
//   2) системный выбор карт по платформе: Android → geo: (чузер), iOS → maps.apple.com?daddr=,
//      десктоп → Google Maps в новой вкладке.
//   3) видимый тост «Поехали!…» — без него Андрею кажется, что «ничего не происходит».
// Отдельные Apple/Google убраны (телефон сам предложит приложение). Tesla-share спрятан в «⋯».
// «Скопировать точку» оставлен. stopPropagation — чтобы клик по кнопкам не открывал хаб.
export default function ProjectNavActions({ project, profile, projectName, address, lat, lng }: ProjectNavActionsProps) {
  const { t } = useI18n()
  const [copied, setCopied] = useState<'point' | null>(null)
  const [toast, setToast] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const destination = getNavigationDestination({ address, lat, lng })
  if (!destination) return null

  const googleUrl = buildGoogleMapsUrl(destination)
  const appleUrl = buildAppleMapsUrl(destination)
  const shareText = buildNavigationShareText({ projectName, destination, address })
  const pointText = buildCoordinateCopyText({ lat, lng })

  const flashPoint = () => {
    setCopied('point')
    window.setTimeout(() => setCopied((cur) => (cur === 'point' ? null : cur)), 1500)
  }
  const copyPoint = async (text: string) => {
    try { await navigator.clipboard.writeText(text); flashPoint() } catch { /* не фатально */ }
  }
  const flashToast = () => {
    setToast(true)
    window.setTimeout(() => setToast(false), 3200)
  }
  const go = () => {
    // (1) Пишем travel.started + уведомляем клиента — строго best-effort, промах не мешает навигации.
    if (profile) {
      startProjectTravel(profile, project, new Date().toISOString()).catch(() => { /* best-effort */ })
    }
    // (3) Видимая обратная связь сразу — тишина = «ничего не происходит».
    flashToast()
    // (2) Системный выбор приложения карт по платформе.
    const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent
    const isIos = /iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && /Mobile/i.test(userAgent))
    const isAndroid = /Android/i.test(userAgent)
    if (isIos) {
      window.location.href = appleUrl
    } else if (isAndroid) {
      window.location.href = buildGeoNavigationUrl(destination, { projectName, userAgent })
    } else {
      window.open(googleUrl, '_blank', 'noopener,noreferrer')
    }
  }
  const shareTesla = async () => {
    setMoreOpen(false)
    if (typeof navigator !== 'undefined' && navigator.share) {
      try { await navigator.share({ title: projectName, text: shareText, url: googleUrl }); return } catch { /* отменили — копируем точку */ }
    }
    await copyPoint(pointText ?? buildAddressCopyText({ address, destination }))
  }

  return (
    <div className="project-nav-actions" onClick={(e) => e.stopPropagation()}>
      <button type="button" className="btn primary small project-nav-go" onClick={go}>🧭 {t('proj_nav_go')}</button>
      {pointText && (
        <button type="button" className="btn ghost small" onClick={() => void copyPoint(pointText)}>
          {copied === 'point' ? `✓ ${t('proj_nav_copied')}` : `📍 ${t('proj_nav_copy_point')}`}
        </button>
      )}
      <div className="project-nav-more">
        <button
          type="button"
          className="btn ghost small project-nav-more-toggle"
          aria-expanded={moreOpen}
          aria-label={t('proj_nav_more')}
          onClick={() => setMoreOpen((open) => !open)}
        >⋯</button>
        {moreOpen && (
          <div className="project-nav-more-menu" role="menu">
            <button type="button" className="btn ghost small" role="menuitem" onClick={() => void shareTesla()}>🚗 {t('proj_nav_tesla')}</button>
          </div>
        )}
      </div>
      {toast && <div className="travel-toast" role="status" aria-live="polite">{t('proj_nav_travel_toast')}</div>}
    </div>
  )
}

// Кнопка «Скопировать адрес» для строки адреса карточки — отдельный компонент со своим
// состоянием «скопировано», чтобы не мигать остальными кнопками навигации.
export function CopyAddressButton({ address }: { address: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(normalizeAddressForCopy(address) ?? address)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch { /* не фатально */ }
  }
  return (
    <button
      type="button"
      className="btn ghost small project-address-copy"
      title={t('proj_nav_copy_address')}
      aria-label={t('proj_nav_copy_address')}
      onClick={(e) => { e.stopPropagation(); void copy() }}
    >
      {copied ? '✓' : '📋'}
    </button>
  )
}
