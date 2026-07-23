import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../lib/i18n'
import VoiceMic from '../components/VoiceMic'
import { isAiInfoProposalAction } from '../lib/aiVoice'
import { getAiUsage, getToolingProposals, type AiProposal } from '../lib/api/ai'
import {
  aggregateAiUsage,
  searchMessages,
  dedupeProposalsByTitle,
  formatUsd,
  formatTokens,
  type AiUsageSummary,
} from '../lib/aiUsageCore'
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

  // ASSISTANT-PAGE-42 (фаза-2): три блока прозрачности ассистента, читаемые напрямую из прода —
  // 💰 расход (events ai.chat → aiUsageCore.aggregateAiUsage), 🛠 «что мне нужно» (ai_proposals
  // action_type='tooling', корневой дедуп по title в окне 24ч). 🧠 Память переиспользует a.messages
  // (тот же getAiMessages, что уже грузит движок) с чистым подстрочным фильтром searchMessages.
  const [usage, setUsage] = useState<AiUsageSummary | null>(null)
  const [tooling, setTooling] = useState<AiProposal[]>([])
  const [memoryQuery, setMemoryQuery] = useState('')

  useEffect(() => {
    let alive = true
    void (async () => {
      const [events, toolingRows] = await Promise.all([getAiUsage(), getToolingProposals()])
      if (!alive) return
      setUsage(aggregateAiUsage(events, new Date().toISOString(), 30))
      setTooling(dedupeProposalsByTitle(toolingRows, 24))
    })()
    return () => { alive = false }
  }, [])

  const memoryMatches = searchMessages(a.messages, memoryQuery)
  // Максимум входных+выходных токенов за день — для инлайн-бара разбивки (без граф-библиотек).
  const maxDayTokens = usage
    ? usage.byDay.reduce((m, d) => Math.max(m, d.tokensIn + d.tokensOut), 0)
    : 0

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

      {/* ASSISTANT-PAGE-42 (блок 💰): расход на ИИ — агрегат событий ai.chat (токены in/out → $ по
          прайсу моделей). Итог + разбивка по дням за 30 дн. с инлайн-баром (без граф-библиотек). */}
      <section className="card ask-usage" aria-label={t('ai_usage_title')}>
        <h2 className="ask-block-title">{t('ai_usage_title')}</h2>
        {usage && usage.count > 0 ? (
          <>
            <div className="ask-usage-totals">
              <div className="ask-usage-stat">
                <span className="ask-usage-stat-value">{formatUsd(usage.totalUsd)}</span>
                <span className="muted small">{t('ai_usage_total')}</span>
              </div>
              <div className="ask-usage-stat">
                <span className="ask-usage-stat-value">{formatTokens(usage.totalIn)}</span>
                <span className="muted small">{t('ai_usage_tokens_in')}</span>
              </div>
              <div className="ask-usage-stat">
                <span className="ask-usage-stat-value">{formatTokens(usage.totalOut)}</span>
                <span className="muted small">{t('ai_usage_tokens_out')}</span>
              </div>
            </div>
            {usage.approx && <p className="muted small ask-usage-approx">{t('ai_usage_approx')}</p>}
            {usage.byDay.length > 0 && (
              <div className="ask-usage-days">
                <p className="muted small ask-usage-days-title">{t('ai_usage_by_day')}</p>
                <table className="ask-usage-table">
                  <tbody>
                    {[...usage.byDay].reverse().map((d) => (
                      <tr key={d.date}>
                        <td className="ask-usage-date">{d.date}</td>
                        <td className="ask-usage-bar-cell">
                          <span
                            className="ask-usage-bar"
                            style={{ width: `${maxDayTokens > 0 ? Math.round(((d.tokensIn + d.tokensOut) / maxDayTokens) * 100) : 0}%` }}
                            aria-hidden="true"
                          />
                        </td>
                        <td className="ask-usage-num muted small">{formatTokens(d.tokensIn + d.tokensOut)}</td>
                        <td className="ask-usage-cost">{formatUsd(d.usd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <p className="muted small ask-block-empty">{t('ai_usage_empty')}</p>
        )}
      </section>

      {/* ASSISTANT-PAGE-42 (блок 🧠): память — что Marvel знает из ai_messages (переиспользуем
          a.messages движка). Поле поиска фильтрует по подстроке content (чистый searchMessages). */}
      <section className="card ask-memory" aria-label={t('ai_memory_title')}>
        <h2 className="ask-block-title">{t('ai_memory_title')}</h2>
        <p className="muted small ask-block-desc">{t('ai_memory_desc')}</p>
        {a.messages.length > 0 ? (
          <>
            <input
              className="ai-input ask-memory-search"
              type="search"
              value={memoryQuery}
              onChange={(e) => setMemoryQuery(e.target.value)}
              placeholder={t('ai_memory_search')}
            />
            {memoryMatches.length > 0 ? (
              <ul className="ask-memory-list">
                {memoryMatches.map((m) => (
                  <li key={m.id} className={`ask-memory-row ask-memory-${m.role}`}>
                    <span className="ask-memory-role muted small">
                      {m.role === 'user' ? t('ai_hist_you') : t('ai_hist_ai')}
                    </span>
                    <span className="ask-memory-text">
                      {m.role === 'assistant' ? stripMarkdown(m.content) : m.content}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small ask-block-empty">{t('ai_memory_none_found')}</p>
            )}
          </>
        ) : (
          <p className="muted small ask-block-empty">{t('ai_memory_empty')}</p>
        )}
      </section>

      {/* ASSISTANT-PAGE-42 (блок 🛠): «что мне нужно» — предложения ai_proposals action_type='tooling'
          (инструменты, которых ассистенту не хватает). В проде пока НОЛЬ → аккуратное пустое состояние. */}
      <section className="card ask-tooling" aria-label={t('ai_tooling_title')}>
        <h2 className="ask-block-title">{t('ai_tooling_title')}</h2>
        <p className="muted small ask-block-desc">{t('ai_tooling_desc')}</p>
        {tooling.length > 0 ? (
          <ul className="ask-tooling-list">
            {tooling.map((pr) => (
              <li key={pr.id} className="ask-tooling-row">
                <span className="ask-tooling-title">{pr.title}</span>
                <span className="ask-tooling-status muted small">{pr.status}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small ask-block-empty">{t('ai_tooling_empty')}</p>
        )}
      </section>

      {/* ASSISTANT-PAGE-3 (п.4): лёгкая диагностика последнего голосового прогона — ТОЛЬКО из памяти
          сессии (телеметрия voice:*, что уже собирает клиент). Никаких запросов в БД. */}
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
