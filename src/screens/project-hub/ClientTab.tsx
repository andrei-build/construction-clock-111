import { useI18n } from '../../lib/i18n'

export default function ClientTab() {
  const { t } = useI18n()
  return (
    <section className="card hub-placeholder">
      <h2>{t('hub_tab_client')}</h2>
      <p className="muted">{t('hub_coming_soon')}</p>
    </section>
  )
}
