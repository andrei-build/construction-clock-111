import { useEffect, useMemo, useState } from 'react'
import { useI18n } from '../lib/i18n'
import { encodeQr, qrToSvg } from '../lib/qr'

// INSTALL-PWA-40: публичная страница /install (БЕЗ логина) — «человеческая» установка
// приложения на телефон в два тыка. Работник открывает ссылку (или сканирует QR), жмёт
// одну кнопку / повторяет 2–3 шага — и иконка Marvel появляется на главном экране.
// Автоопределение платформы: Android/Chrome (нативный beforeinstallprompt), iOS Safari
// (пошаговая инструкция — нативного prompt в iOS нет), прочее (QR на телефон).

// Минимальный тип нативного события установки PWA (нет в стандартных lib.dom типах).
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

type Platform = 'android' | 'ios' | 'ios-not-safari' | 'other'

// Грубое, но надёжное для полевого сценария определение платформы по userAgent.
function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'other'
  const ua = navigator.userAgent || ''
  const isIOS = /iphone|ipad|ipod/i.test(ua) ||
    // iPadOS 13+ маскируется под Mac — ловим по тач-экрану.
    (/Macintosh/.test(ua) && typeof document !== 'undefined' && 'ontouchend' in document)
  if (isIOS) {
    // В iOS «Добавить на экран Домой» доступно ТОЛЬКО из Safari. Chrome/Firefox на iOS (CriOS/FxiOS)
    // используют тот же WebKit, но пункта установки не дают.
    const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)
    return isSafari ? 'ios' : 'ios-not-safari'
  }
  if (/android/i.test(ua)) return 'android'
  return 'other'
}

// standalone = приложение уже открыто как установленное (с главного экрана).
function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    // iOS Safari отдаёт это нестандартное поле для home-screen web app.
    (navigator as unknown as { standalone?: boolean }).standalone === true
  )
}

// Десктопный вьюпорт = широкий экран И «точный» указатель (мышь). На телефоне (узкий
// вьюпорт ИЛИ тач) QR-код и «Скопировать ссылку» бессмысленны — работник уже открыл
// страницу на своём телефоне, сканировать сам себя незачем. QR оставляем ТОЛЬКО на
// десктопе: владелец показывает код работнику, тот наводит камеру. SSR-дефолт = десктоп.
function isDesktopViewport(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return true
  const narrow = window.matchMedia('(max-width: 700px)').matches
  const coarse = window.matchMedia('(pointer: coarse)').matches
  return !narrow && !coarse
}

export default function InstallApp() {
  const { t } = useI18n()
  const [platform] = useState<Platform>(detectPlatform)
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState<boolean>(isStandalone)
  const [isDesktop, setIsDesktop] = useState<boolean>(isDesktopViewport)
  const [copied, setCopied] = useState(false)

  const url = typeof window !== 'undefined' ? `${window.location.origin}/install` : '/install'

  // QR ссылки на страницу установки — генерим один раз (dep-free). try/catch: битый ввод не роняет UI.
  const qrSvg = useMemo(() => {
    try {
      return qrToSvg(encodeQr(url, 'M'), { size: 208, dark: '#0f1420', light: '#ffffff' })
    } catch {
      return ''
    }
  }, [url])

  // Ловим событие установки ЗАРАНЕЕ (навешиваем на mount): браузер эмитит его один раз,
  // до клика пользователя. preventDefault откладывает мини-инфобар, показываем свою кнопку.
  useEffect(() => {
    const onBeforeInstall = (e: Event) => {
      e.preventDefault()
      setDeferredPrompt(e as BeforeInstallPromptEvent)
    }
    const onInstalled = () => {
      setInstalled(true)
      setDeferredPrompt(null)
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  // Пересчитываем «десктоп/мобайл» при смене ширины окна (ротация/ресайз): QR должен
  // прятаться/появляться отзывчиво, а не только на первый рендер.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(max-width: 700px)')
    const update = () => setIsDesktop(isDesktopViewport())
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  const doInstall = async () => {
    if (!deferredPrompt) return
    await deferredPrompt.prompt()
    const choice = await deferredPrompt.userChoice
    if (choice.outcome === 'accepted') setInstalled(true)
    setDeferredPrompt(null)
  }

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="install-page">
      <div className="install-card">
        <div className="install-brand" aria-hidden="true">
          <img src="/icon.svg" alt="" width={72} height={72} />
        </div>
        <h1 className="install-title">{t('install_title')}</h1>
        <p className="install-subtitle">{t('install_subtitle')}</p>

        {installed ? (
          <div className="install-done">
            <div className="install-done-icon" aria-hidden="true">✓</div>
            <p className="install-done-title">{t('install_done_title')}</p>
            <p className="install-muted">{t('install_done_desc')}</p>
          </div>
        ) : (
          <>
            {/* Android/Chrome: нативный prompt, если событие пришло; иначе — ручная инструкция. */}
            {platform === 'android' && (
              deferredPrompt ? (
                <div className="install-action">
                  <button className="install-btn" onClick={doInstall}>{t('install_btn')}</button>
                  <p className="install-muted">{t('install_android_ready')}</p>
                </div>
              ) : (
                <ol className="install-steps">
                  <li><span className="install-step-ic">⋮</span>{t('install_android_step1')}</li>
                  <li><span className="install-step-ic">＋</span>{t('install_android_step2')}</li>
                  <li><span className="install-step-ic">✓</span>{t('install_android_step3')}</li>
                </ol>
              )
            )}

            {/* iOS Safari: нативного prompt нет — только пошагово. */}
            {platform === 'ios' && (
              <ol className="install-steps">
                <li><span className="install-step-ic">⬆️</span>{t('install_ios_step1')}</li>
                <li><span className="install-step-ic">➕</span>{t('install_ios_step2')}</li>
                <li><span className="install-step-ic">✓</span>{t('install_ios_step3')}</li>
              </ol>
            )}

            {/* iOS не в Safari: установка невозможна — просим открыть в Safari. */}
            {platform === 'ios-not-safari' && (
              <div className="install-note">
                <span className="install-badge">Safari</span>
                <p className="install-muted">{t('install_ios_open_safari')}</p>
              </div>
            )}

            {/* Десктоп/прочее: сканировать QR телефоном. */}
            {platform === 'other' && (
              <p className="install-muted install-other">{t('install_other_scan')}</p>
            )}
          </>
        )}

        {/* QR + «Скопировать ссылку» — ТОЛЬКО на десктопе: владелец показывает код работнику.
            На телефоне (узкий вьюпорт/тач) прячем — там нужны лишь шаги установки + кнопка. */}
        {!installed && isDesktop && qrSvg && (
          <div className="install-qr">
            <div className="install-qr-img" dangerouslySetInnerHTML={{ __html: qrSvg }} />
            <p className="install-muted">{t('install_qr_hint')}</p>
          </div>
        )}

        {isDesktop && (
          <div className="install-link-row">
            <code className="install-url">{url}</code>
            <button className="install-copy" onClick={copyLink}>
              {copied ? t('install_link_copied') : t('install_copy_link')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
