import { useRef, useState } from 'react'
import { useI18n } from '../lib/i18n'
import { startProjectTravel } from '../lib/api'
import type { Profile, Project } from '../lib/types'
import {
  haversineMeters,
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

const GEO_TIMEOUT_MS = 5000
const GEO_MAX_AGE_MS = 60000
const ROAD_WINDING_FACTOR = 1.25
const AVERAGE_DRIVING_MPH = 28

function finiteNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : null
}

function requestBrowserPosition(): Promise<GeolocationPosition | null> {
  if (typeof window === 'undefined' || typeof navigator === 'undefined' || !navigator.geolocation) {
    return Promise.resolve(null)
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = (position: GeolocationPosition | null) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      resolve(position)
    }
    const timer = window.setTimeout(() => finish(null), GEO_TIMEOUT_MS)
    try {
      navigator.geolocation.getCurrentPosition(
        (position) => finish(position),
        () => finish(null),
        { timeout: GEO_TIMEOUT_MS, maximumAge: GEO_MAX_AGE_MS },
      )
    } catch {
      finish(null)
    }
  })
}

function etaMinutesFromPosition(position: GeolocationPosition, projectLat: number, projectLng: number): number | null {
  const straightLineMeters = haversineMeters(
    position.coords.latitude,
    position.coords.longitude,
    projectLat,
    projectLng,
  )
  const metersPerMinute = AVERAGE_DRIVING_MPH * 1609.344 / 60
  const etaMinutes = Math.round(straightLineMeters * ROAD_WINDING_FACTOR / metersPerMinute)
  return Number.isFinite(etaMinutes) ? Math.max(1, etaMinutes) : null
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
  const [toastEtaMinutes, setToastEtaMinutes] = useState<number | null>(null)
  const toastTimerRef = useRef<number | null>(null)
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
  const flashToast = (etaMinutes?: number | null) => {
    setToastEtaMinutes(etaMinutes ?? null)
    setToast(true)
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => {
      setToast(false)
      setToastEtaMinutes(null)
      toastTimerRef.current = null
    }, 3200)
  }
  const travelEtaPromise = (): Promise<number | null> => {
    const projectLat = finiteNumber(lat ?? project.lat)
    const projectLng = finiteNumber(lng ?? project.lng)
    if (projectLat === null || projectLng === null) return Promise.resolve(null)
    return requestBrowserPosition().then((position) => (
      position ? etaMinutesFromPosition(position, projectLat, projectLng) : null
    ))
  }
  const go = () => {
    const startedAt = new Date().toISOString()
    const etaPromise = travelEtaPromise()
    // (1) Пишем travel.started + уведомляем клиента — строго best-effort, промах не мешает навигации.
    if (profile) {
      void etaPromise
        .then((etaMinutes) => startProjectTravel(profile, project, startedAt, {
          ...(etaMinutes != null ? { eta_minutes: etaMinutes } : {}),
          traveler_profile_id: profile.id,
        }))
        .catch(() => { /* best-effort */ })
    }
    // (3) Видимая обратная связь сразу — тишина = «ничего не происходит».
    flashToast()
    void etaPromise
      .then((etaMinutes) => {
        if (etaMinutes != null) flashToast(etaMinutes)
      })
      .catch(() => { /* best-effort */ })
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
      {toast && (
        <div className="travel-toast" role="status" aria-live="polite">
          {toastEtaMinutes != null
            ? t('proj_nav_travel_toast_eta').replace('{n}', String(toastEtaMinutes))
            : t('proj_nav_travel_toast')}
        </div>
      )}
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
