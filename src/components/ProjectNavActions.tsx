import { useState } from 'react'
import { useI18n } from '../lib/i18n'
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
  projectName: string
  address?: string | null
  lat?: number | string | null
  lng?: number | string | null
}

// PROJ-1b STEP 2: навигация на карточке /projects — «В путь» / Apple / Google / Tesla-share
// + «Скопировать точку». Паритет с Check Time ProjectNavigationActions. Клипборд-/share-ошибки
// не фатальны — ссылки на карты всё равно работают. stopPropagation, чтобы не открывать хаб.
export default function ProjectNavActions({ projectName, address, lat, lng }: ProjectNavActionsProps) {
  const { t } = useI18n()
  const [copied, setCopied] = useState<'point' | null>(null)
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
  const go = () => {
    window.location.href = buildGeoNavigationUrl(destination, {
      projectName,
      userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    })
  }
  const shareTesla = async () => {
    if (typeof navigator !== 'undefined' && navigator.share) {
      try { await navigator.share({ title: projectName, text: shareText, url: googleUrl }); return } catch { /* отменили — копируем точку */ }
    }
    await copyPoint(pointText ?? buildAddressCopyText({ address, destination }))
  }

  return (
    <div className="project-nav-actions" onClick={(e) => e.stopPropagation()}>
      <button type="button" className="btn ghost small project-nav-go" onClick={go}>🧭 {t('proj_nav_go')}</button>
      <a className="btn ghost small" href={appleUrl} target="_blank" rel="noopener noreferrer">🍎 {t('proj_nav_apple')}</a>
      <a className="btn ghost small" href={googleUrl} target="_blank" rel="noopener noreferrer">🗺️ {t('proj_nav_google')}</a>
      <button type="button" className="btn ghost small" onClick={() => void shareTesla()}>🚗 {t('proj_nav_tesla')}</button>
      {pointText && (
        <button type="button" className="btn ghost small" onClick={() => void copyPoint(pointText)}>
          {copied === 'point' ? `✓ ${t('proj_nav_copied')}` : `📍 ${t('proj_nav_copy_point')}`}
        </button>
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
