import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import {
  getProjects,
  getTodayEvents,
  addTimeEvent,
  captureGPS,
  startProjectTravel,
  uploadCheckoutVideo,
  uploadSafetySignature,
  validateUpload,
  uploadErrorCode,
} from '../lib/api'
import {
  flushQueuedTimeEvents,
  getQueuedTimeEvents,
  queuedTimeEventToTimeEvent,
  queueTimeEvent,
  type QueuedTimeEvent,
} from '../lib/offlineTimeQueue'
import { shiftState, workedMs, fmtHours, fmtClock } from '../lib/time'
import type { Project, TimeEvent } from '../lib/types'

interface TravelState {
  projectId: string
  startedAt: Date
}

function isOnline() {
  return typeof navigator === 'undefined' || navigator.onLine
}

function isNetworkError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /failed to fetch|networkerror|network|fetch|load failed/i.test(message)
}

function messageClass(msg: string) {
  if (msg === 'error') return 'error-msg'
  if (['offline_saved', 'checkout_video_needed', 'checkout_video_online_required', 'safety_signature_required', 'safety_online_required', 'consent_agree_required', 'file_too_large', 'file_type_not_allowed'].includes(msg)) return 'warn-msg'
  return 'ok-msg'
}

// Low-accuracy warning threshold (metres), matching old Check Time behavior.
// Advisory only — the fix is still recorded with its accuracy; check-in is never blocked.
function lowGpsAccuracy(geo: Awaited<ReturnType<typeof captureGPS>>): number | null {
  if (geo.status !== 'good' || geo.accuracy == null || geo.accuracy <= 100) return null
  return Math.round(geo.accuracy)
}

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('signature_empty'))
    }, 'image/png')
  })
}

export default function CheckIn() {
  const { profile } = useAuth()
  const { t } = useI18n()
  const [projects, setProjects] = useState<Project[]>([])
  const [events, setEvents] = useState<TimeEvent[]>([])
  const [queued, setQueued] = useState<QueuedTimeEvent[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [travelBusy, setTravelBusy] = useState(false)
  const [travel, setTravel] = useState<TravelState | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [gpsWarnM, setGpsWarnM] = useState<number | null>(null)
  const [checkoutVideo, setCheckoutVideo] = useState<File | null>(null)
  const [confirmingCheckout, setConfirmingCheckout] = useState(false)
  const [safetyProjectId, setSafetyProjectId] = useState<string | null>(null)
  const [signatureTouched, setSignatureTouched] = useState(false)
  const [consentName, setConsentName] = useState('')
  const [consentAgreed, setConsentAgreed] = useState(false)
  const drawingRef = useRef(false)
  const signatureCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const syncRef = useRef(false)
  const [, tick] = useState(0)

  const load = useCallback(async () => {
    if (!profile) return
    try {
      const [ps, evs] = await Promise.all([getProjects(), getTodayEvents(profile.id)])
      setProjects(ps)
      setEvents(evs)
    } catch {
      // Offline check-in can continue with the last in-memory state and the durable queue.
    }
    setQueued(await getQueuedTimeEvents(profile.id))
  }, [profile])

  const syncQueue = useCallback(async () => {
    if (!profile || syncRef.current || !isOnline()) return
    syncRef.current = true
    setSyncing(true)
    try {
      await flushQueuedTimeEvents(profile, (sent) => {
        setQueued((rows) => rows.filter((row) => row.id !== sent.id))
      })
      await load()
    } catch {
      setMsg('offline_saved')
    } finally {
      syncRef.current = false
      setSyncing(false)
    }
  }, [load, profile])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const i = setInterval(() => tick((x) => x + 1), 1000)
    return () => clearInterval(i)
  }, [])
  useEffect(() => {
    window.addEventListener('online', syncQueue)
    return () => window.removeEventListener('online', syncQueue)
  }, [syncQueue])
  useEffect(() => {
    if (queued.length > 0 && isOnline()) syncQueue()
  }, [queued.length, syncQueue])

  const visibleEvents = useMemo(() => (
    [...events, ...queued.map(queuedTimeEventToTimeEvent)]
      .sort((a, b) => a.event_time.localeCompare(b.event_time))
  ), [events, queued])
  const state = useMemo(() => shiftState(visibleEvents), [visibleEvents])
  const ms = useMemo(() => workedMs(visibleEvents), [visibleEvents, Date.now()])
  const selectedProject = useMemo(() => projects.find((p) => p.id === selected) ?? null, [projects, selected])
  const safetyProject = useMemo(() => projects.find((p) => p.id === safetyProjectId) ?? null, [projects, safetyProjectId])
  const checkoutRequiresVideo = Boolean(profile?.require_checkout_video)
  const selectedNeedsSafety = Boolean(selected && !visibleEvents.some((event) =>
    event.event_type === 'check_in' && event.project_id === selected
  ))

  const completeOnlineTimeEvent = async (
    type: 'check_in' | 'check_out' | 'break_start' | 'break_end',
    projectId: string | null,
    geo: Awaited<ReturnType<typeof captureGPS>>,
    options: { checkoutVideo?: File | null; signatureBlob?: Blob | null } = {},
  ) => {
    if (!profile) throw new Error('missing_profile')
    const eventId = await addTimeEvent(profile, type, projectId, geo)
    if (options.checkoutVideo) {
      setMsg('checkout_video_uploading')
      await uploadCheckoutVideo(profile, eventId, options.checkoutVideo)
    }
    if (options.signatureBlob && projectId) {
      setMsg('safety_uploading')
      await uploadSafetySignature(profile, projectId, eventId, options.signatureBlob)
    }
    return eventId
  }

  const act = async (type: 'check_in' | 'check_out' | 'break_start' | 'break_end') => {
    if (!profile || busy) return
    if (type === 'check_in' && !selected) return
    if (type === 'check_in' && selectedNeedsSafety) {
      setSafetyProjectId(selected)
      setSignatureTouched(false)
      setConsentName('')
      setConsentAgreed(false)
      setMsg(null)
      return
    }
    const requiresVideo = type === 'check_out' && checkoutRequiresVideo
    const videoFile = requiresVideo ? checkoutVideo : null
    if (requiresVideo && !videoFile) {
      setMsg('checkout_video_needed')
      return
    }
    setBusy(true)
    setMsg('gps_wait')
    setGpsWarnM(null)
    const geo = await captureGPS()
    setMsg(geo.status === 'good' ? 'gps_ok' : 'gps_fail')
    setGpsWarnM(lowGpsAccuracy(geo))
    const projectId = type === 'check_in' ? selected : state.projectId
    const saveOffline = async () => {
      const row = await queueTimeEvent(profile, type, projectId, geo)
      setQueued((rows) => [...rows.filter((item) => item.id !== row.id), row].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt)))
      if (type === 'check_in') setTravel(null)
      setMsg('offline_saved')
    }

    try {
      if (!isOnline()) {
        if (requiresVideo) {
          setMsg('checkout_video_online_required')
          return
        }
        await saveOffline()
        return
      }
      await completeOnlineTimeEvent(type, projectId, geo, { checkoutVideo: videoFile })
      await load()
      if (type === 'check_in') setTravel(null)
      if (type === 'check_out') setCheckoutVideo(null)
      setMsg('saved')
      setTimeout(() => setMsg(null), 2500)
    } catch (error) {
      if (isNetworkError(error) && !requiresVideo) await saveOffline()
      else if (requiresVideo && isNetworkError(error)) setMsg('checkout_video_online_required')
      else setMsg('error')
    } finally {
      setBusy(false)
    }
  }

  // Подтверждение перед чек-аутом: случайный тап не должен закрывать смену.
  // Подтверждение предшествует act('check_out') (и, соответственно, видео-флоу),
  // а «Cancel — stay checked in» просто закрывает панель, не трогая состояние смены.
  const requestCheckout = () => {
    if (busy) return
    setConfirmingCheckout(true)
  }
  const cancelCheckout = () => setConfirmingCheckout(false)
  const confirmCheckout = () => {
    setConfirmingCheckout(false)
    act('check_out')
  }

  const signaturePoint = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = signatureCanvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    }
  }

  const beginSignature = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = signatureCanvasRef.current
    const point = signaturePoint(event)
    if (!canvas || !point) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drawingRef.current = true
    setSignatureTouched(true)
    ctx.lineWidth = 4
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = '#edf6fb'
    ctx.beginPath()
    ctx.moveTo(point.x, point.y)
  }

  const drawSignature = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return
    const canvas = signatureCanvasRef.current
    const point = signaturePoint(event)
    if (!canvas || !point) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.lineTo(point.x, point.y)
    ctx.stroke()
  }

  const endSignature = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    drawingRef.current = false
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const clearSignature = () => {
    const canvas = signatureCanvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    setSignatureTouched(false)
  }

  const submitSafetyCheckIn = async () => {
    if (!profile || !safetyProjectId || busy) return
    const canvas = signatureCanvasRef.current
    if (!canvas || !signatureTouched) {
      setMsg('safety_signature_required')
      return
    }
    // Паритет с Check Time (canConfirmGpsConsent): напечатанное имя + явная галочка «Согласен» — клиентский гейт.
    if (consentName.trim().length === 0 || !consentAgreed) {
      setMsg('consent_agree_required')
      return
    }
    if (!isOnline()) {
      setMsg('safety_online_required')
      return
    }

    setBusy(true)
    try {
      const signatureBlob = await canvasToBlob(canvas)
      setMsg('gps_wait')
      setGpsWarnM(null)
      const geo = await captureGPS()
      setMsg(geo.status === 'good' ? 'gps_ok' : 'gps_fail')
      setGpsWarnM(lowGpsAccuracy(geo))
      await completeOnlineTimeEvent('check_in', safetyProjectId, geo, { signatureBlob })
      await load()
      setTravel(null)
      setSafetyProjectId(null)
      setSignatureTouched(false)
      setConsentName('')
      setConsentAgreed(false)
      setMsg('safety_saved')
      setTimeout(() => setMsg(null), 2500)
    } catch (error) {
      if (isNetworkError(error)) setMsg('safety_online_required')
      else setMsg('error')
    } finally {
      setBusy(false)
    }
  }

  const startTravel = async (project: Project) => {
    if (!profile || travelBusy || !project.address) return
    const startedAt = new Date()
    const url = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(project.address)}`
    setTravel({ projectId: project.id, startedAt })
    window.open(url, '_blank')
    setTravelBusy(true)
    try {
      await startProjectTravel(profile, project, startedAt.toISOString())
    } catch {
      setMsg('error')
    } finally {
      setTravelBusy(false)
    }
  }

  const projName = (id: string | null) => projects.find((p) => p.id === id)?.name ?? ''
  // Валидируем видео при выборе (лимит/тип до сети); при отказе показываем код через существующий msg.
  const pickCheckoutVideo = (file: File | null) => {
    if (!file) { setCheckoutVideo(null); return }
    try {
      validateUpload(file, 'video')
    } catch (err) {
      setMsg(uploadErrorCode(err) ?? 'error')
      setCheckoutVideo(null)
      return
    }
    setMsg(null)
    setCheckoutVideo(file)
  }

  const checkoutVideoBlock = checkoutRequiresVideo ? (
    <div className="card checkout-video-card">
      <div className="item-title">{t('checkout_video_title')}</div>
      <p className="muted">{t('checkout_video_hint')}</p>
      <input
        id="checkout-video"
        className="photo-input"
        type="file"
        accept="video/*"
        capture="environment"
        disabled={busy}
        onChange={(event) => pickCheckoutVideo(event.target.files?.[0] ?? null)}
      />
      <label className={`video-button ${busy ? 'disabled' : ''}`} htmlFor="checkout-video">
        <span className="camera-icon">🎥</span>
        <span>{checkoutVideo ? t('video_replace') : t('video_record')}</span>
      </label>
      {checkoutVideo && <p className="ok-msg video-file-name">{checkoutVideo.name}</p>}
    </div>
  ) : null

  if (safetyProject) {
    return (
      <div className="screen safety-screen">
        <h1>🦺 {t('safety_title')}</h1>
        <div className="card safety-card">
          <div className="item-title">{safetyProject.name}</div>
          <p className="muted">{t('safety_intro')}</p>
          <ol className="safety-list">
            <li>{t('safety_rule_1')}</li>
            <li>{t('safety_rule_2')}</li>
            <li>{t('safety_rule_3')}</li>
            <li>{t('safety_rule_4')}</li>
            <li>{t('safety_rule_5')}</li>
            <li>{t('safety_rule_6')}</li>
            <li>{t('safety_rule_7')}</li>
            <li>{t('safety_rule_8')}</li>
            <li>{t('safety_rule_9')}</li>
            <li>{t('safety_rule_10')}</li>
          </ol>
          <div className="safety-refs">
            <div className="safety-refs-title">{t('safety_refs_title')}</div>
            <ul className="safety-refs-list">
              <li>{t('safety_ref_155')}</li>
              <li>{t('safety_ref_155_110')}</li>
              <li>{t('safety_ref_155_205')}</li>
              <li>{t('safety_ref_155_426')}</li>
              <li>{t('safety_ref_880')}</li>
              <li>{t('safety_ref_876')}</li>
            </ul>
          </div>
          <label>{t('signature')}</label>
          <canvas
            ref={signatureCanvasRef}
            className="signature-canvas"
            width={640}
            height={220}
            onPointerDown={beginSignature}
            onPointerMove={drawSignature}
            onPointerUp={endSignature}
            onPointerCancel={endSignature}
            onPointerLeave={endSignature}
          />
          <div className="row safety-actions">
            <button className="btn ghost small" type="button" disabled={busy} onClick={clearSignature}>{t('clear_signature')}</button>
            <button className="btn ghost small" type="button" disabled={busy} onClick={() => { setSafetyProjectId(null); setMsg(null) }}>{t('cancel')}</button>
          </div>
          <label htmlFor="consent-name">{t('consent_name_label')}</label>
          <input
            id="consent-name"
            className="consent-name-input"
            type="text"
            autoComplete="name"
            disabled={busy}
            placeholder={t('consent_name_placeholder')}
            value={consentName}
            onChange={(event) => setConsentName(event.target.value)}
          />
          <label className="consent-agree">
            <input
              type="checkbox"
              disabled={busy}
              checked={consentAgreed}
              onChange={(event) => setConsentAgreed(event.target.checked)}
            />
            <span>{t('consent_agree_label')}</span>
          </label>
        </div>
        <button className="btn green" disabled={busy || !signatureTouched || consentName.trim().length === 0 || !consentAgreed} onClick={submitSafetyCheckIn}>
          {busy ? t('loading') : t('safety_accept_checkin')}
        </button>
        {msg && <p className={messageClass(msg)}>{t(msg)}</p>}
        {gpsWarnM != null && <p className="warn-msg">{t('gps_low_accuracy').replace('{n}', String(gpsWarnM))}</p>}
      </div>
    )
  }

  return (
    <div className="screen">
      <h1>⏱️ {t('checkin')}</h1>

      <div className="card center">
        {state.status === 'off' && <p className="muted">{t('not_on_shift')}</p>}
        {state.status !== 'off' && (
          <>
            <p className="muted">
              {state.status === 'break' ? t('on_break') : `${t('on_shift_since')} ${state.since ? fmtClock(state.since) : ''}`}
              {state.projectId ? ` · ${projName(state.projectId)}` : ''}
            </p>
            <div className="timer">{fmtHours(ms)} {t('h')}</div>
          </>
        )}
      </div>

      {queued.length > 0 && (
        <div className="offline-queue">
          <span className={`offline-dot ${syncing ? 'syncing' : ''}`} />
          <div>
            <div className="offline-title">{syncing ? t('offline_queue_sending') : t('offline_saved')}</div>
            <div className="muted">{t('queued_marks')}: {queued.length}</div>
          </div>
        </div>
      )}

      {state.status === 'off' && (
        <>
          <h2>{t('select_project')}</h2>
          {projects.map((p) => (
            <div key={p.id} className={`card tap ${selected === p.id ? 'selected' : ''}`} onClick={() => setSelected(p.id)}>
              <div className="row">
                <div>
                  <div style={{ fontWeight: 700 }}>{p.name}</div>
                  <div className="muted">{p.address}</div>
                </div>
                {selected === p.id && <span className="badge amber">✓</span>}
              </div>
              {selected === p.id && (
                <div className="travel-action" onClick={(e) => e.stopPropagation()}>
                  {travel?.projectId === p.id ? (
                    <p className="ok-msg">{t('travel_started')} {fmtClock(travel.startedAt.toISOString())}</p>
                  ) : (
                    <button className="btn ghost small" disabled={travelBusy || !selectedProject?.address} onClick={() => startTravel(p)}>
                      {t('travel_start')}
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
          <button className="btn green" style={{ marginTop: 12 }} disabled={!selected || busy} onClick={() => act('check_in')}>
            {t('check_in')}
          </button>
        </>
      )}

      {state.status === 'on' && (
        <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
          <button className="btn ghost" disabled={busy} onClick={() => act('break_start')}>{t('break_start')}</button>
          {checkoutVideoBlock}
          <button className="btn red" disabled={busy || (checkoutRequiresVideo && !checkoutVideo)} onClick={requestCheckout}>
            {t('finish_shift')}
          </button>
        </div>
      )}

      {state.status === 'break' && (
        <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
          <button className="btn" disabled={busy} onClick={() => act('break_end')}>{t('break_end')}</button>
          {checkoutVideoBlock}
          <button className="btn red" disabled={busy || (checkoutRequiresVideo && !checkoutVideo)} onClick={requestCheckout}>
            {t('finish_shift')}
          </button>
        </div>
      )}

      {msg && <p className={messageClass(msg)}>{t(msg)}</p>}
      {gpsWarnM != null && <p className="warn-msg">{t('gps_low_accuracy').replace('{n}', String(gpsWarnM))}</p>}

      {confirmingCheckout && (
        <div className="confirm-backdrop" onClick={cancelCheckout}>
          <div className="card confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="item-title">{t('confirm_checkout_title')}</div>
            <p className="muted">{t('confirm_checkout_body')}</p>
            <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
              <button className="btn red" type="button" disabled={busy} onClick={confirmCheckout}>
                {t('confirm_checkout_do')}
              </button>
              <button className="btn ghost" type="button" disabled={busy} onClick={cancelCheckout}>
                {t('confirm_checkout_stay')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
