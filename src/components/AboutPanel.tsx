import { useI18n } from '../lib/i18n'

// App version fallback — mirrors package.json "version". No build tooling is wired
// to inject a version at build time (no vite define, no VITE_* var), so we surface
// import.meta.env.VITE_APP_VERSION when present and fall back to this constant.
const APP_VERSION = '0.1.0'

// Purely presentational, read-only owner diagnostics. Shows only build info that is
// actually available from Vite's built-in import.meta.env — commit SHA / branch /
// build time rows are intentionally omitted because nothing exposes them here.
export default function AboutPanel() {
  const { t } = useI18n()

  const env = import.meta.env
  const version = (env.VITE_APP_VERSION as string | undefined) || APP_VERSION
  const mode = env.MODE
  const baseUrl = env.BASE_URL || window.location.origin

  const rows: { label: string; value: string }[] = [
    { label: t('about_version'), value: version },
    { label: t('about_env'), value: mode },
    { label: t('about_base_url'), value: baseUrl },
  ]

  return (
    <div className="about-panel card">
      <h3 className="about-panel-title">{t('about_release')}</h3>
      <dl className="about-panel-rows">
        {rows.map((r) => (
          <div key={r.label} className="about-panel-row">
            <dt>{r.label}</dt>
            <dd>{r.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
