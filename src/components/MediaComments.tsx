import { useEffect, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { getMediaComments, addMediaComment } from '../lib/api'
import type { MediaComment } from '../lib/types'

const localeByLang = {
  ru: 'ru-RU',
  en: 'en-US',
  es: 'es-ES',
} as const

// Блок комментариев к одному медиа (mediaId — реальный media.id).
// v1: только текст (без голоса). Используется в лайтбоксе галереи и под фото задачи.
export default function MediaComments({ mediaId }: { mediaId: string }) {
  const { profile } = useAuth()
  const { t, lang } = useI18n()
  const [comments, setComments] = useState<MediaComment[]>([])
  const [loading, setLoading] = useState(true)
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    setLoading(true)
    setError(null)
    getMediaComments(mediaId).then((rows) => {
      if (mounted) {
        setComments(rows)
        setLoading(false)
      }
    })
    return () => { mounted = false }
  }, [mediaId])

  const submit = async () => {
    if (!profile || busy) return
    const text = body.trim()
    if (!text) return
    setBusy(true)
    setError(null)
    try {
      const created = await addMediaComment(profile, mediaId, text)
      if (created) setComments((current) => [...current, created])
      setBody('')
    } catch {
      setError(t('media_comment_error'))
    } finally {
      setBusy(false)
    }
  }

  const formatTime = (iso: string) =>
    new Intl.DateTimeFormat(localeByLang[lang], {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    }).format(new Date(iso))

  return (
    <div className="media-comments">
      <div className="media-comments-title">💬 {t('media_comments')}</div>

      {loading ? (
        <div className="muted media-comments-empty">{t('loading')}</div>
      ) : comments.length === 0 ? (
        <div className="muted media-comments-empty">{t('media_comments_empty')}</div>
      ) : (
        <ul className="media-comments-list">
          {comments.map((c) => (
            <li key={c.id} className="media-comments-item">
              <div className="media-comments-meta">
                <span className="media-comments-author">
                  {c.author?.name ?? t('media_comment_unknown_author')}
                </span>
                <span className="media-comments-time muted">{formatTime(c.created_at)}</span>
              </div>
              <div className="media-comments-body">{c.body}</div>
            </li>
          ))}
        </ul>
      )}

      {profile && (
        <div className="media-comments-form">
          <input
            type="text"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t('media_comment_placeholder')}
            disabled={busy}
            onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
          />
          <button
            type="button"
            className="btn small"
            disabled={busy || !body.trim()}
            onClick={submit}
          >
            {t('media_comment_submit')}
          </button>
        </div>
      )}

      {error && <p className="error-msg" style={{ fontSize: 12 }}>{error}</p>}
    </div>
  )
}
