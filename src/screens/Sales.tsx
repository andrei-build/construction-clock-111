import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { getDeals, updateDealStage } from '../lib/api'
import type { Deal, DealStage } from '../lib/types'

const stages: DealStage[] = ['lead', 'contacted', 'measured', 'quoted', 'negotiation', 'signed', 'handed_off', 'lost']
const nextStage: Partial<Record<DealStage, DealStage>> = {
  lead: 'contacted',
  contacted: 'measured',
  measured: 'quoted',
  quoted: 'negotiation',
  negotiation: 'signed',
  signed: 'handed_off',
}

export default function Sales() {
  const { profile } = useAuth()
  const { t } = useI18n()
  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState(false)

  const load = async () => {
    setLoading(true)
    setError(false)
    try {
      setDeals(await getDeals())
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [profile?.id])

  const byStage = useMemo(() => {
    const map = new Map<DealStage, Deal[]>()
    for (const stage of stages) map.set(stage, [])
    for (const deal of deals) map.get(deal.stage)?.push(deal)
    return map
  }, [deals])

  const money = (value: number | null) =>
    value === null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value)

  const move = async (deal: Deal, stage: DealStage) => {
    if (!profile || busy) return
    setBusy(deal.id)
    setError(false)
    try {
      await updateDealStage(profile, deal, stage)
      await load()
    } catch {
      setError(true)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="screen sales-screen">
      <h1>🤝 {t('sales')}</h1>
      {loading && <div className="card center muted">{t('loading')}</div>}
      {error && <p className="error-msg">{t('load_error')}</p>}
      {!loading && deals.length === 0 && <div className="card muted">{t('no_deals')}</div>}

      <div className="sales-board">
        {stages.map((stage) => (
          <section className="sales-column" key={stage}>
            <h2>{t(`deal_stage_${stage}`)}</h2>
            {(byStage.get(stage) ?? []).length === 0 && <div className="card muted">{t('empty_stage')}</div>}
            {(byStage.get(stage) ?? []).map((deal) => (
              <div className="card deal-card" key={deal.id}>
                <div className="item-title">{deal.title}</div>
                <div className="deal-amount">{money(deal.expected_amount)}</div>
                {deal.next_action && <p className="muted">{deal.next_action}</p>}
                {stage === 'signed' ? (
                  <button className="btn small" disabled={busy !== null} onClick={() => move(deal, 'handed_off')}>
                    {t('handoff_to_production')}
                  </button>
                ) : nextStage[stage] ? (
                  <button className="btn ghost small" disabled={busy !== null} onClick={() => move(deal, nextStage[stage]!)}>
                    {t('next_stage')}
                  </button>
                ) : null}
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  )
}
