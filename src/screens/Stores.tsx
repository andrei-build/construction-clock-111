import { useEffect, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { getSupplyStores, createSupplyStore, setSupplyStoreActive, getStoreVisits } from '../lib/api'
import type { SupplyStore, StoreVisit } from '../lib/types'

const localeByLang = {
  ru: 'ru-RU',
  en: 'en-US',
  es: 'es-ES',
} as const

export default function Stores() {
  const { profile } = useAuth()
  const { t, lang } = useI18n()
  const [stores, setStores] = useState<SupplyStore[]>([])
  const [visits, setVisits] = useState<StoreVisit[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [radius, setRadius] = useState('120')
  const [lat, setLat] = useState('')
  const [lng, setLng] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(false)

  useEffect(() => {
    let mounted = true
    async function load() {
      setLoading(true)
      setError(false)
      try {
        const [s, v] = await Promise.all([getSupplyStores(), getStoreVisits()])
        if (mounted) {
          setStores(s)
          setVisits(v)
        }
      } catch {
        if (mounted) {
          setStores([])
          setVisits([])
          setError(true)
        }
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => { mounted = false }
  }, [profile?.id])

  const formatDate = (iso: string) =>
    new Intl.DateTimeFormat(localeByLang[lang], {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    }).format(new Date(iso))

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!profile || saving || !name.trim()) return
    setSaving(true)
    setSaveError(false)
    try {
      const radiusNum = Number.parseInt(radius, 10)
      const latNum = Number.parseFloat(lat)
      const lngNum = Number.parseFloat(lng)
      const created = await createSupplyStore(profile, {
        name: name.trim(),
        address: address.trim() || undefined,
        radius_m: Number.isFinite(radiusNum) ? radiusNum : undefined,
        lat: Number.isFinite(latNum) ? latNum : undefined,
        lng: Number.isFinite(lngNum) ? lngNum : undefined,
      })
      if (created) setStores((rows) => [...rows, created].sort((a, b) => a.name.localeCompare(b.name)))
      setName('')
      setAddress('')
      setRadius('120')
      setLat('')
      setLng('')
    } catch {
      setSaveError(true)
    } finally {
      setSaving(false)
    }
  }

  async function handleToggle(store: SupplyStore) {
    if (!profile || busyId) return
    setBusyId(store.id)
    try {
      await setSupplyStoreActive(profile, store.id, !store.is_active)
      setStores((rows) => rows.map((r) => (r.id === store.id ? { ...r, is_active: !r.is_active } : r)))
    } catch {
      setSaveError(true)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="screen">
      <h1>🏬 {t('stores')}</h1>

      {loading && <div className="card center muted">{t('loading')}</div>}
      {error && <p className="error-msg">{t('load_error')}</p>}

      {!loading && !error && (
        <>
          <h2>{t('stores_directory')}</h2>

          <form className="card" onSubmit={handleAdd}>
            <input
              type="text"
              placeholder={t('stores_name')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <input
              type="text"
              placeholder={t('stores_address')}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
            <input
              type="number"
              placeholder={t('stores_radius')}
              value={radius}
              onChange={(e) => setRadius(e.target.value)}
            />
            <div className="row" style={{ gap: 8 }}>
              <input
                type="number"
                step="any"
                placeholder={t('stores_lat')}
                value={lat}
                onChange={(e) => setLat(e.target.value)}
              />
              <input
                type="number"
                step="any"
                placeholder={t('stores_lng')}
                value={lng}
                onChange={(e) => setLng(e.target.value)}
              />
            </div>
            {saveError && <p className="error-msg">{t('stores_save_failed')}</p>}
            <button type="submit" className="btn" disabled={saving || !name.trim()}>
              {saving ? t('stores_saving') : t('stores_add')}
            </button>
          </form>

          {stores.length === 0 && <div className="card muted">{t('stores_empty')}</div>}

          {stores.map((store) => (
            <div key={store.id} className={`card row ${store.is_active ? '' : 'muted'}`}>
              <div>
                <span className="item-title">{store.name}</span>
                <div className="muted" style={{ fontSize: 12 }}>
                  {store.address ? `${store.address} · ` : ''}
                  {t('stores_radius_label')} {store.radius_m}м
                  {!store.is_active && <> · {t('stores_inactive')}</>}
                </div>
              </div>
              <button
                type="button"
                className="btn small"
                disabled={busyId === store.id}
                onClick={() => handleToggle(store)}
              >
                {store.is_active ? t('stores_deactivate') : t('stores_activate')}
              </button>
            </div>
          ))}

          <h2>{t('stores_visits')}</h2>
          {visits.length === 0 && <div className="card muted">{t('stores_no_visits')}</div>}
          {visits.map((visit) => {
            // REP-1/0033: открытый заезд = exited_at IS NULL (работник сейчас в магазине).
            const isOpen = visit.exited_at === null
            return (
              <div key={visit.id} className="card row">
                <div>
                  <span className="item-title">
                    {visit.worker?.name ?? t('stores_unknown_worker')}
                    {isOpen && <span className="badge amber" style={{ marginLeft: 6 }}>{t('stores_visit_open')}</span>}
                  </span>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {visit.store?.name ?? t('stores_unknown_store')}
                    {visit.project?.name ? ` · ${visit.project.name}` : ''}
                    {' · '}
                    {formatDate(visit.entered_at)}
                    {visit.exited_at ? ` — ${formatDate(visit.exited_at)}` : ''}
                  </div>
                  {visit.note && <div className="muted" style={{ fontSize: 12 }}>{visit.note}</div>}
                </div>
                <span className={`badge ${visit.is_paid ? 'green' : 'red'}`}>
                  {visit.is_paid ? t('stores_paid') : t('stores_unpaid')}
                </span>
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}
