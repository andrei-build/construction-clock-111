import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { useImageLightbox, type LightboxImage } from '../components/ImageLightbox'
import VoiceMic from '../components/VoiceMic'
import {
  getCatalogItems,
  createCatalogItem,
  updateCatalogItem,
  setCatalogItemActive,
  deleteCatalogItem,
  getCatalogPriceHistory,
  uploadCatalogPhoto,
  CATALOG_CATEGORIES,
} from '../lib/api'
import type { CatalogItem, CatalogCategory, CatalogItemInput, CatalogPriceHistoryRow } from '../lib/api'

const CATEGORY_LABEL_KEY: Record<CatalogCategory, string> = {
  shower: 'catalog_cat_shower',
  vanity: 'catalog_cat_vanity',
  cabinet: 'catalog_cat_cabinet',
  light: 'catalog_cat_light',
  fan: 'catalog_cat_fan',
  other: 'catalog_cat_other',
}

type FormState = {
  category: CatalogCategory
  name: string
  brand: string
  model: string
  width_in: string
  depth_in: string
  height_in: string
  price: string
  url: string
  note: string
  is_active: boolean
  photo_path: string | null
}

const emptyForm = (): FormState => ({
  category: 'shower',
  name: '',
  brand: '',
  model: '',
  width_in: '',
  depth_in: '',
  height_in: '',
  price: '',
  url: '',
  note: '',
  is_active: true,
  photo_path: null,
})

const fromItem = (item: CatalogItem): FormState => ({
  category: item.category,
  name: item.name,
  brand: item.brand ?? '',
  model: item.model ?? '',
  width_in: item.width_in != null ? String(item.width_in) : '',
  depth_in: item.depth_in != null ? String(item.depth_in) : '',
  height_in: item.height_in != null ? String(item.height_in) : '',
  price: item.price != null ? String(item.price) : '',
  url: item.url ?? '',
  note: item.note ?? '',
  is_active: item.is_active,
  photo_path: item.photo_path,
})

// Пустая строка/нечисло → null; иначе число. Дюймы и цена опциональны.
const numOrNull = (s: string): number | null => {
  const n = Number.parseFloat(s)
  return s.trim() !== '' && Number.isFinite(n) ? n : null
}

const dims = (item: CatalogItem): string | null => {
  const parts = [item.width_in, item.depth_in, item.height_in]
  if (parts.every((p) => p == null)) return null
  return parts.map((p) => (p == null ? '—' : p)).join('×')
}

const MS_PER_DAY = 86_400_000

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null
  const time = new Date(iso).getTime()
  if (!Number.isFinite(time)) return null
  return Math.max(0, Math.floor((Date.now() - time) / MS_PER_DAY))
}

function historyDate(row: CatalogPriceHistoryRow): string | null {
  return row.recorded_at ?? row.created_at ?? row.changed_at ?? row.updated_at ?? null
}

function parseValidDate(value: string | null): Date | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

function historyPrice(row: CatalogPriceHistoryRow): number | null {
  const value = row.new_price ?? row.price
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function historyPreviousPrice(row: CatalogPriceHistoryRow): number | null {
  const value = row.old_price ?? row.previous_price
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

export default function Catalog() {
  const { profile } = useAuth()
  const { t, lang } = useI18n()
  // LIGHTBOX-1: фото позиций каталога открываем В ПРИЛОЖЕНИИ (общий лайтбокс), не в отдельной вкладке.
  const lb = useImageLightbox()
  const [items, setItems] = useState<CatalogItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [search, setSearch] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [historyOpenId, setHistoryOpenId] = useState<string | null>(null)
  const [historyLoadingId, setHistoryLoadingId] = useState<string | null>(null)
  const [priceHistory, setPriceHistory] = useState<Record<string, CatalogPriceHistoryRow[]>>({})

  // null — модалка закрыта; иначе id редактируемой позиции или 'new'.
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let mounted = true
    async function load() {
      setLoading(true)
      setError(false)
      try {
        const rows = await getCatalogItems()
        if (mounted) setItems(rows)
      } catch {
        if (mounted) { setItems([]); setError(true) }
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => { mounted = false }
  }, [profile?.id])

  const priceFmt = useMemo(
    () => new Intl.NumberFormat(lang === 'ru' ? 'ru-RU' : lang === 'es' ? 'es-ES' : 'en-US', {
      style: 'currency', currency: 'USD', maximumFractionDigits: 2,
    }),
    [lang],
  )

  const dateFmt = useMemo(
    () => new Intl.DateTimeFormat(lang === 'ru' ? 'ru-RU' : lang === 'es' ? 'es-ES' : 'en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    [lang],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return items
    return items.filter((it) =>
      it.name.toLowerCase().includes(q)
      || (it.brand ?? '').toLowerCase().includes(q)
      || (it.model ?? '').toLowerCase().includes(q))
  }, [items, search])

  const grouped = useMemo(
    () => CATALOG_CATEGORIES.map((cat) => ({ cat, rows: filtered.filter((it) => it.category === cat) }))
      .filter((g) => g.rows.length > 0),
    [filtered],
  )

  function openNew() {
    setForm(emptyForm())
    setFormError(null)
    setEditing('new')
  }

  function openEdit(item: CatalogItem) {
    setForm(fromItem(item))
    setFormError(null)
    setEditing(item.id)
  }

  function closeForm() {
    setEditing(null)
    setSaving(false)
    setUploading(false)
    setFormError(null)
  }

  async function handlePhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (fileRef.current) fileRef.current.value = ''
    if (!file || !profile) return
    setUploading(true)
    setFormError(null)
    try {
      const url = await uploadCatalogPhoto(profile, file)
      setForm((f) => ({ ...f, photo_path: url }))
    } catch {
      setFormError(t('catalog_photo_failed'))
    } finally {
      setUploading(false)
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!profile || saving) return
    if (!form.name.trim()) { setFormError(t('catalog_name_required')); return }
    setSaving(true)
    setFormError(null)
    const input: CatalogItemInput = {
      category: form.category,
      name: form.name.trim(),
      brand: form.brand.trim() || null,
      model: form.model.trim() || null,
      width_in: numOrNull(form.width_in),
      depth_in: numOrNull(form.depth_in),
      height_in: numOrNull(form.height_in),
      price: numOrNull(form.price),
      url: form.url.trim() || null,
      note: form.note.trim() || null,
      is_active: form.is_active,
      photo_path: form.photo_path,
    }
    try {
      if (editing === 'new') {
        const created = await createCatalogItem(profile, input)
        setItems((rows) => [...rows, created])
      } else if (editing) {
        const updated = await updateCatalogItem(profile, editing, input)
        setItems((rows) => rows.map((r) => (r.id === updated.id ? updated : r)))
      }
      closeForm()
    } catch {
      setFormError(t('catalog_save_failed'))
      setSaving(false)
    }
  }

  async function handleToggle(item: CatalogItem) {
    if (!profile || busyId) return
    setBusyId(item.id)
    try {
      const updated = await setCatalogItemActive(profile, item.id, !item.is_active)
      setItems((rows) => rows.map((r) => (r.id === updated.id ? updated : r)))
    } catch {
      setError(true)
    } finally {
      setBusyId(null)
    }
  }

  async function handleDelete(item: CatalogItem) {
    if (!profile || busyId) return
    if (!window.confirm(t('catalog_delete_confirm'))) return
    setBusyId(item.id)
    try {
      await deleteCatalogItem(profile, item.id)
      setItems((rows) => rows.filter((r) => r.id !== item.id))
    } catch {
      setError(true)
    } finally {
      setBusyId(null)
    }
  }

  async function togglePriceHistory(item: CatalogItem) {
    const nextOpen = historyOpenId === item.id ? null : item.id
    setHistoryOpenId(nextOpen)
    if (!nextOpen || priceHistory[item.id]) return
    setHistoryLoadingId(item.id)
    try {
      const rows = await getCatalogPriceHistory(item.id, 5)
      setPriceHistory((prev) => ({ ...prev, [item.id]: rows }))
    } catch {
      setPriceHistory((prev) => ({ ...prev, [item.id]: [] }))
    } finally {
      setHistoryLoadingId(null)
    }
  }

  const priceAgeLabel = (item: CatalogItem): string | null => {
    const days = daysSince(item.price_updated_at)
    if (days == null) return null
    if (days === 0) return t('catalog_price_updated_today')
    if (days === 1) return t('catalog_price_updated_yesterday')
    return `${t('catalog_price_updated_prefix')} ${days} ${t('catalog_price_updated_suffix')}`
  }

  return (
    <div className="screen">
      {lb.node}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>🗂️ {t('catalog_title')}</h1>
        <button type="button" className="btn" onClick={openNew}>{t('catalog_add')}</button>
      </div>
      <p className="muted" style={{ marginTop: -4 }}>{t('catalog_subtitle')}</p>

      <input
        type="search"
        className="catalog-search"
        placeholder={t('catalog_search')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {loading && <div className="card center muted">{t('loading')}</div>}
      {error && <p className="error-msg">{t('load_error')}</p>}

      {!loading && !error && items.length === 0 && (
        <div className="card muted">{t('catalog_empty')}</div>
      )}
      {!loading && !error && items.length > 0 && grouped.length === 0 && (
        <div className="card muted">{t('catalog_empty_search')}</div>
      )}

      {!loading && !error && grouped.map((group) => (
        <section key={group.cat} className="catalog-group">
          <h2>{t(CATEGORY_LABEL_KEY[group.cat])}</h2>
          <div className="catalog-grid">
            {group.rows.map((item) => {
              const d = dims(item)
              const ageLabel = priceAgeLabel(item)
              const itemHistory = priceHistory[item.id] ?? []
              const historyOpen = historyOpenId === item.id
              return (
                <div key={item.id} className={`card catalog-card ${item.is_active ? '' : 'muted'}`}>
                  <div className="catalog-thumb">
                    {item.photo_path
                      ? (
                        <button
                          type="button"
                          className="catalog-thumb-btn"
                          onClick={() => {
                            const withPhoto = group.rows.filter((r) => r.photo_path)
                            const idx = Math.max(0, withPhoto.findIndex((r) => r.id === item.id))
                            lb.open(
                              withPhoto.map<LightboxImage>((r) => ({ id: r.id, name: r.name, resolve: () => Promise.resolve(r.photo_path as string) })),
                              idx,
                            )
                          }}
                        >
                          <img src={item.photo_path} alt={item.name} loading="lazy" />
                        </button>
                      )
                      : <span className="catalog-thumb-empty" aria-hidden="true">🖼️</span>}
                  </div>
                  <div className="catalog-body">
                    <div className="item-title">{item.name}</div>
                    {(item.brand || item.model) && (
                      <div className="muted" style={{ fontSize: 12 }}>
                        {[item.brand, item.model].filter(Boolean).join(' · ')}
                      </div>
                    )}
                    {d && <div className="muted" style={{ fontSize: 12 }}>{t('catalog_dims')}: {d}</div>}
                    <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      {item.price != null && <span className="item-title">{priceFmt.format(item.price)}</span>}
                      {ageLabel && <span className="badge blue">{ageLabel}</span>}
                      {!item.is_active && <span className="badge red">{t('catalog_inactive')}</span>}
                      {item.url && (
                        <a href={item.url} target="_blank" rel="noreferrer" className="muted" style={{ fontSize: 12 }}>
                          {t('catalog_open_link')}
                        </a>
                      )}
                    </div>
                    {item.note && <div className="muted" style={{ fontSize: 12 }}>{item.note}</div>}
                    <button type="button" className="btn small ghost catalog-history-toggle" onClick={() => togglePriceHistory(item)}>
                      {historyOpen ? t('catalog_price_history_hide') : t('catalog_price_history_show')}
                    </button>
                    {historyOpen && (
                      <div className="catalog-price-history">
                        {historyLoadingId === item.id && <div className="muted">{t('loading')}</div>}
                        {historyLoadingId !== item.id && itemHistory.length === 0 && <div className="muted">{t('catalog_price_history_empty')}</div>}
                        {historyLoadingId !== item.id && itemHistory.map((row, idx) => {
                          const date = parseValidDate(historyDate(row))
                          const price = historyPrice(row)
                          const prev = historyPreviousPrice(row)
                          return (
                            <div className="catalog-price-history-row" key={row.id ?? `${item.id}-${idx}`}>
                              <span>{date ? dateFmt.format(date) : t('date')}</span>
                              <strong>{price != null ? priceFmt.format(price) : '—'}</strong>
                              {prev != null && <span className="muted">{t('catalog_price_prev')}: {priceFmt.format(prev)}</span>}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                  <div className="catalog-actions">
                    <button type="button" className="btn small" disabled={busyId === item.id} onClick={() => handleToggle(item)}>
                      {item.is_active ? t('catalog_inactive') : t('catalog_field_active')}
                    </button>
                    <button type="button" className="btn small ghost" disabled={busyId === item.id} onClick={() => openEdit(item)}>
                      {t('catalog_edit')}
                    </button>
                    <button type="button" className="btn small red" disabled={busyId === item.id} onClick={() => handleDelete(item)}>
                      {t('catalog_delete')}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      ))}

      {editing && (
        <div className="confirm-backdrop" role="dialog" aria-modal="true" onClick={closeForm}>
          <form className="card catalog-modal" onSubmit={handleSave} onClick={(e) => e.stopPropagation()}>
            <h2>{editing === 'new' ? t('catalog_add') : t('catalog_edit')}</h2>

            <label>{t('catalog_field_category')}</label>
            <select value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value as CatalogCategory }))}>
              {CATALOG_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>{t(CATEGORY_LABEL_KEY[cat])}</option>
              ))}
            </select>

            <label>{t('catalog_field_name')}</label>
            <div className="catalog-field-voice">
              <input type="text" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required />
              <VoiceMic lang={lang} title={t('voice_input')} onResult={(x) => setForm((f) => ({ ...f, name: f.name ? `${f.name} ${x}` : x }))} />
            </div>

            <label>{t('catalog_field_brand')}</label>
            <div className="catalog-field-voice">
              <input type="text" value={form.brand} onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))} />
              <VoiceMic lang={lang} title={t('voice_input')} onResult={(x) => setForm((f) => ({ ...f, brand: f.brand ? `${f.brand} ${x}` : x }))} />
            </div>

            <label>{t('catalog_field_model')}</label>
            <div className="catalog-field-voice">
              <input type="text" value={form.model} onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))} />
              <VoiceMic lang={lang} title={t('voice_input')} onResult={(x) => setForm((f) => ({ ...f, model: f.model ? `${f.model} ${x}` : x }))} />
            </div>

            <div className="row" style={{ gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label>{t('catalog_field_width')}</label>
                <input type="number" step="any" min="0" value={form.width_in} onChange={(e) => setForm((f) => ({ ...f, width_in: e.target.value }))} />
              </div>
              <div style={{ flex: 1 }}>
                <label>{t('catalog_field_depth')}</label>
                <input type="number" step="any" min="0" value={form.depth_in} onChange={(e) => setForm((f) => ({ ...f, depth_in: e.target.value }))} />
              </div>
              <div style={{ flex: 1 }}>
                <label>{t('catalog_field_height')}</label>
                <input type="number" step="any" min="0" value={form.height_in} onChange={(e) => setForm((f) => ({ ...f, height_in: e.target.value }))} />
              </div>
            </div>

            <label>{t('catalog_field_price')}</label>
            <input type="number" step="any" min="0" value={form.price} onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))} />

            <label>{t('catalog_field_url')}</label>
            <input type="url" value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} />

            <label>{t('catalog_field_note')}</label>
            <div className="catalog-field-voice">
              <textarea rows={2} value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
              <VoiceMic lang={lang} title={t('voice_input')} onResult={(x) => setForm((f) => ({ ...f, note: f.note ? `${f.note} ${x}` : x }))} />
            </div>

            <label>{t('catalog_field_photo')}</label>
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              {form.photo_path && <img className="catalog-form-thumb" src={form.photo_path} alt="" />}
              <input ref={fileRef} type="file" accept="image/*" onChange={handlePhoto} disabled={uploading} />
              {form.photo_path && (
                <button type="button" className="btn small ghost" onClick={() => setForm((f) => ({ ...f, photo_path: null }))}>
                  {t('catalog_photo_remove')}
                </button>
              )}
            </div>
            {uploading && <p className="muted">{t('catalog_uploading')}</p>}

            <label className="row" style={{ gap: 8, alignItems: 'center', marginTop: 8 }}>
              <input type="checkbox" checked={form.is_active} onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))} />
              {t('catalog_field_active')}
            </label>

            {formError && <p className="error-msg">{formError}</p>}

            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <button type="submit" className="btn" disabled={saving || uploading}>
                {saving ? t('catalog_saving') : t('catalog_save')}
              </button>
              <button type="button" className="btn ghost" onClick={closeForm} disabled={saving}>
                {t('catalog_cancel')}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
