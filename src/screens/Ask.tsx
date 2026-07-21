import { useEffect, useRef } from 'react'
import { useI18n } from '../lib/i18n'
import VoiceMic from '../components/VoiceMic'
import { isAiInfoProposalAction } from '../lib/aiVoice'
import {
  useAiAssistant,
  stripMarkdown,
  summarizePayload,
  candidateText,
  KNOWN_ACTIONS,
} from '../components/AiCommandBar'

// ORB-SIMPLE-2: полноэкранная страница ассистента владельца (маршрут /ask). Переиспользует ОДИН движок
// (useAiAssistant) — тот же, что питает угловой орб-рацию, — без дублирования логики и гонок микрофона.
// Стиль = токены приложения (тёмный фон, --panel/--line, радиус 14-16, амбер только на активном).
export default function Ask() {
  const { t } = useI18n()
  const a = useAiAssistant()
  const endRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Автоскролл ленты вниз при новом сообщении / печати живого стрима.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [a.messages, a.streamText, a.thinking])

  // Фокус в поле ввода при входе на страницу.
  useEffect(() => {
    const id = window.setTimeout(() => inputRef.current?.focus(), 80)
    return () => window.clearTimeout(id)
  }, [])

  const orbStyle = {
    '--mic': a.orbState === 'listening' ? a.micLevel : 0,
    '--tts': a.orbState === 'speaking' ? a.ttsLevel : 0,
  } as React.CSSProperties

  // ASSISTANT-PAGE-3 (п.3): ВИЗУАЛЬНЫЙ дедуп карточек-предложений перед рендером (баг: «Записано,
  // передам строителям» ×4). Схлопываем по сигнатуре (kind + summary/payload), оставляя первую.
  // Движок/вставку proposals в AiCommandBar НЕ трогаем — корневой баг дублирования лечит бэкенд Беты-6.
  const seenProposalSig = new Set<string>()
  const uniqueProposals = a.proposals.filter((pr) => {
    const sig = isAiInfoProposalAction(pr.action_type)
      ? `info:${pr.action_type}`
      : `${pr.action_type}|${a.proposalSummary(pr)}|${JSON.stringify(pr.payload)}`
    if (seenProposalSig.has(sig)) return false
    seenProposalSig.add(sig)
    return true
  })

  return (
    <div className="ask-page">
      {/* Шапка страницы: эмблема орба + заголовок + короткий статус голоса. */}
      <header className="ask-head">
        <span
          className={`ai-orb ai-orb-xs ai-orb-${a.orbState}${a.micDenied ? ' ai-orb-denied' : ''}`}
          style={orbStyle}
          aria-hidden="true"
        >
          <span className="ai-orb-ring" />
          <span className="ai-orb-ring ai-orb-ring2" />
          <span className="ai-orb-ring ai-orb-ring3" />
          <span className="ai-orb-ring ai-orb-ring4" />
          <span className="ai-orb-core" />
        </span>
        <div className="ask-head-text">
          <h1 className="ask-title">{t('ai_ask')}</h1>
          <p className="ask-status muted small" role="status" aria-live="polite">{a.orbLabel}</p>
        </div>
      </header>

      {/* Компактный блок настроек чата — на самой странице (не в попапе, не под орбом). */}
      {(a.speakSupported || a.wakeSupported) && (
        <section className="card ask-settings" aria-label={t('ai_settings')}>
          <span className="ask-settings-title muted small">{t('ai_settings')}</span>
          <div className="ask-toggles">
            {a.speakSupported && (
              <label className="ai-toggle">
                <input type="checkbox" checked={a.speakOn} onChange={(e) => a.setSpeakEnabled(e.target.checked)} />
                <span>{t('ai_speak_toggle')}</span>
              </label>
            )}
            {a.wakeSupported && (
              <label className="ai-toggle" title={t('ai_wake_hint')}>
                <input type="checkbox" checked={a.wakeOn} onChange={(e) => a.setWakeEnabled(e.target.checked)} />
                <span>{t('ai_wake_toggle')}</span>
              </label>
            )}
            {/* «Голос»: отдельного пикера пока нет — честно показываем единственный вариант. */}
            <span className="ask-voice-pill">{t('ai_voice_label')}: Jarvis</span>
          </div>
        </section>
      )}

      {a.micDenied && <p className="muted small ask-hint">{t('ai_mic_denied_hint')}</p>}

      {a.noKey && (
        <div className="ai-nokey ask-nokey" role="alert">
          <strong>{t('ai_no_key_title')}</strong>
          <span className="muted small">{t('ai_no_key_desc')}</span>
        </div>
      )}

      {/* Лента диалога + живой стрим печати. */}
      <div className="card ask-history">
        {a.loading && a.messages.length === 0 ? <p className="muted small">…</p> : null}
        {a.messages.map((m) => (
          <div key={m.id} className={`ai-hist-row ai-hist-${m.role}`}>
            <span className="ai-hist-role">{m.role === 'user' ? t('ai_hist_you') : t('ai_hist_ai')}</span>
            <span className="ai-hist-text">{m.role === 'assistant' ? stripMarkdown(m.content) : m.content}</span>
          </div>
        ))}
        {a.streaming && a.streamText && (
          <div className="ai-hist-row ai-hist-assistant">
            <span className="ai-hist-role">{t('ai_hist_ai')}</span>
            <span className="ai-hist-text">{a.streamText}<span className="ai-caret" aria-hidden="true" /></span>
          </div>
        )}
        {(a.thinking || a.streaming) && !a.streamText && (
          <p className="muted small ai-answer-thinking">{t('ai_thinking')}</p>
        )}
        {a.messages.length === 0 && !a.loading && !a.thinking && !a.streaming && (
          <p className="ai-answer-empty muted">{t('ai_empty')}</p>
        )}
        <div ref={endRef} />
      </div>

      {/* Предложения ИИ (pending): выполнить / отклонить — та же логика, что у голосового «да/нет». */}
      {uniqueProposals.length > 0 && (
        <div className="ai-proposals ask-proposals">
          <h2 className="ai-proposals-title">{t('ai_proposals_title')}</h2>
          {uniqueProposals.map((pr) => {
            const known = KNOWN_ACTIONS.has(pr.action_type)
            const rows = summarizePayload(pr.payload)
            const issue = a.proposalIssues[pr.id]
            const candidates = issue?.candidates?.slice(0, 6) ?? []
            if (isAiInfoProposalAction(pr.action_type)) {
              return (
                <div key={pr.id} className="ai-proposal ai-proposal-info card" role="status">
                  <div className="ai-proposal-title">{t('ai_bug_recorded')}</div>
                  <div className="row ai-proposal-actions">
                    <button type="button" className="btn ghost" onClick={() => a.dismissInfoProposal(pr.id)}>
                      {t('got_it')}
                    </button>
                  </div>
                </div>
              )
            }
            return (
              <div key={pr.id} className="ai-proposal card">
                <div className="ai-proposal-title">{t('ai_proposal_prefix')} {a.proposalSummary(pr)}</div>
                {rows.length > 0 && (
                  <dl className="ai-proposal-payload">
                    {rows.map(([k, v]) => (
                      <div key={k} className="ai-payload-row"><dt>{k}</dt><dd>{v}</dd></div>
                    ))}
                  </dl>
                )}
                {issue && (
                  <div className="ai-proposal-issue" role="alert">
                    <p>{a.proposalIssueTitle(issue)}</p>
                    {issue.message && <p className="muted small">{issue.message}</p>}
                    {candidates.length > 0 && (
                      <>
                        <p className="muted small">{t('ai_execute_candidates')}:</p>
                        <ul>
                          {candidates.map((c, idx) => (
                            <li key={`${pr.id}-candidate-${idx}`}>{candidateText(c)}</li>
                          ))}
                        </ul>
                      </>
                    )}
                    <p className="muted small">{t('ai_execute_still_pending')}</p>
                  </div>
                )}
                {!known && <p className="muted small ai-unsupported">{t('ai_unsupported')}</p>}
                <div className="row ai-proposal-actions">
                  {known && (
                    <button
                      type="button"
                      className="btn primary"
                      disabled={a.busyId === pr.id}
                      onClick={() => void a.executeProposal(pr)}
                    >
                      {t('ai_execute')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={a.busyId === pr.id}
                    onClick={() => void a.rejectProposal(pr)}
                  >
                    {t('ai_reject')}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ASSISTANT-PAGE-3 (п.4): лёгкая диагностика последнего голосового прогона — ТОЛЬКО из памяти
          сессии (телеметрия voice:*, что уже собирает клиент). Никаких запросов в БД. Полная история /
          💰расход токенов / 🧠память / 🛠инструменты — отложены (бэкенд Беты-6), здесь их нет. */}
      <details className="card ask-diag">
        <summary className="ask-diag-summary">{t('ai_diag_title')}</summary>
        {a.voiceHeard || a.voiceDiag.length > 0 ? (
          <div className="ask-diag-body">
            {a.voiceHeard && (
              <p className="ask-diag-heard">
                <span className="muted small">{t('ai_diag_heard')}:</span> {a.voiceHeard}
              </p>
            )}
            {a.voiceDiag.length > 0 && (
              <>
                <p className="muted small ask-diag-stages-title">{t('ai_diag_stages')}</p>
                <ul className="ask-diag-list">
                  {a.voiceDiag.map((ev, idx) => (
                    <li key={`${idx}-${ev.stage}`}>
                      <code>{ev.stage}</code>
                      {ev.detail ? <span className="muted small"> {ev.detail}</span> : null}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        ) : (
          <p className="muted small ask-diag-empty">{t('ai_diag_empty')}</p>
        )}
      </details>

      {/* Ввод: текст + микрофон (push-to-talk) + отправка. */}
      <form className="ai-input-row ask-input-row" onSubmit={a.submit}>
        <input
          ref={inputRef}
          className="ai-input"
          type="text"
          value={a.input}
          onChange={(e) => a.setInput(e.target.value)}
          placeholder={t('ai_placeholder')}
          disabled={a.thinking}
        />
        <VoiceMic lang={a.lang} title={t('ai_voice_hint')} onResult={(text) => { void a.handleVoiceInput(text) }} />
        <button type="submit" className="btn primary ai-send-btn" disabled={a.thinking || !a.input.trim()}>
          {a.thinking ? t('ai_thinking') : t('ai_send')}
        </button>
      </form>
    </div>
  )
}
