import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { signLocationConsent } from '../lib/api'

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('signature_empty'))
    }, 'image/png')
  })
}

// Полноэкранное согласие на GPS-отслеживание — показывается работнику/водителю до экрана отметки (закон WA)
export default function GpsConsent({ onSigned }: { onSigned: () => void }) {
  const { profile } = useAuth()
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [signatureTouched, setSignatureTouched] = useState(false)
  const drawingRef = useRef(false)
  const signatureCanvasRef = useRef<HTMLCanvasElement | null>(null)

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

  const submit = async () => {
    if (!profile || busy) return
    const canvas = signatureCanvasRef.current
    if (!canvas || !signatureTouched) {
      setMsg('gps_consent_sign_required')
      return
    }
    setBusy(true)
    setMsg(null)
    try {
      const signature = await canvasToBlob(canvas)
      await signLocationConsent(profile, signature)
      onSigned()
    } catch {
      setMsg('error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="screen safety-screen">
      <h1>📍 {t('gps_consent_title')}</h1>
      <div className="card safety-card">
        <p className="muted">{t('gps_consent_body')}</p>
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
        </div>
      </div>
      <button className="btn green" disabled={busy || !signatureTouched} onClick={submit}>
        {busy ? t('loading') : t('gps_consent_sign')}
      </button>
      {msg && <p className={msg === 'error' ? 'error-msg' : 'warn-msg'}>{t(msg)}</p>}
    </div>
  )
}
