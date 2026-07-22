// TILE-CATALOG-29: реальный каталог плитки для режима Отделка → Плитка (референс §5).
// ФРОНТ-полоса: статичный сид ходовых позиций Floor & Decor / MSI + хелперы (бренд/размер/цена/фото).
// Настоящие данные и импорт по ссылке вольёт бэкенд (tile_catalog + edge tile-import) за Бетой-7 —
// здесь важна СТРУКТУРА (по образцу cabinetCatalog.ts), а не полнота. photoUrl — плейсхолдер
// (инлайн-SVG data-URI), внешние ассеты в бандл НЕ тянем, новых npm-deps НЕ добавляем.

export type TileBrand = 'Floor & Decor' | 'MSI' | 'other'

export type TilePriceUnit = 'sqft' | 'piece'

export type TileFormat = 'subway' | 'plank' | 'field' | 'mosaic' | 'penny' | 'hex' | 'herringbone'

// Позиция каталога: реальные размеры Ш×В (дюймы), цена-заглушка (за sqft или за шт) и фото-плейсхолдер.
export type TileCatalogEntry = {
  id: string
  brand: TileBrand
  collection: string
  name: string
  widthIn: number
  heightIn: number
  priceUsd: number
  priceUnit: TilePriceUnit
  format: TileFormat
  color: string
  groutColor: string
  photoUrl: string
}

// Минимальный «скелет» для расчёта стоимости зоны — годится и для позиции каталога, и для сохранённого
// в эскизе выбора (после перезагрузки id может быть не из сида, если позицию влил бэкенд).
export type TileCostBasis = {
  priceUsd: number
  priceUnit: TilePriceUnit
  widthIn: number
  heightIn: number
}

export const TILE_CATALOG_BRANDS: readonly TileBrand[] = ['Floor & Decor', 'MSI', 'other'] as const

// --- Фото-плейсхолдер: КОМПАКТНЫЙ инлайн-SVG по цвету/шву/формату. Один мотив одной плитки (шов-рамка
// + акцент формата), чтобы data-URI оставался маленьким и годился и для карточки, и для тайла на
// развёртке (<image> тайлится по ячейке). Никаких внешних картинок/ассетов, никаких новых deps. ---

function tileFormatAccent(groutColor: string, format: TileFormat): string {
  const line = (x1: number, y1: number, x2: number, y2: number) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${groutColor}" stroke-width="2"/>`
  switch (format) {
    case 'subway':
      return line(2, 32, 62, 32)
    case 'plank':
      return line(22, 2, 22, 62) + line(44, 2, 44, 62)
    case 'field':
      return ''
    case 'mosaic':
      return line(2, 32, 62, 32) + line(32, 2, 32, 62)
    case 'penny':
      return `<circle cx="32" cy="32" r="22" fill="none" stroke="${groutColor}" stroke-width="2"/>`
    case 'hex':
      return `<polygon points="32,6 54,19 54,45 32,58 10,45 10,19" fill="none" stroke="${groutColor}" stroke-width="2"/>`
    case 'herringbone':
      return line(6, 58, 58, 6) + line(24, 62, 62, 24)
    default:
      return ''
  }
}

export function tilePhotoDataUri(color: string, groutColor: string, format: TileFormat): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">` +
    `<rect width="64" height="64" fill="${groutColor}"/>` +
    `<rect x="2" y="2" width="60" height="60" rx="3" fill="${color}"/>` +
    tileFormatAccent(groutColor, format) +
    `</svg>`
  const base64 = typeof btoa === 'function' ? btoa(svg) : Buffer.from(svg, 'utf-8').toString('base64')
  return `data:image/svg+xml;base64,${base64}`
}

// --- Сид: ~37 ходовых позиций обоих брендов (цены — ЗАГЛУШКИ, реальные вольёт бэкенд) ---

type TileSeed = Omit<TileCatalogEntry, 'photoUrl'>

const TILE_CATALOG_SEED: readonly TileSeed[] = [
  // Floor & Decor
  { id: 'fd-subway-white-3x6', brand: 'Floor & Decor', collection: 'Nabi', name: 'White Gloss Subway', widthIn: 3, heightIn: 6, priceUsd: 0.35, priceUnit: 'piece', format: 'subway', color: '#f5f6f7', groutColor: '#c9ced6' },
  { id: 'fd-subway-white-4x12', brand: 'Floor & Decor', collection: 'Nabi', name: 'White Gloss 4x12', widthIn: 4, heightIn: 12, priceUsd: 0.79, priceUnit: 'piece', format: 'subway', color: '#f3f4f6', groutColor: '#c9ced6' },
  { id: 'fd-subway-gray-3x6', brand: 'Floor & Decor', collection: 'Nabi', name: 'Gray Matte Subway', widthIn: 3, heightIn: 6, priceUsd: 0.39, priceUnit: 'piece', format: 'subway', color: '#b6bcc4', groutColor: '#6b7280' },
  { id: 'fd-carrara-12x24', brand: 'Floor & Decor', collection: 'Nuvo', name: 'Carrara Matte 12x24', widthIn: 12, heightIn: 24, priceUsd: 4.99, priceUnit: 'sqft', format: 'field', color: '#eef0f2', groutColor: '#b7bcc4' },
  { id: 'fd-calacatta-24x48', brand: 'Floor & Decor', collection: 'Nuvo', name: 'Calacatta Polished 24x48', widthIn: 24, heightIn: 48, priceUsd: 6.49, priceUnit: 'sqft', format: 'field', color: '#f4f2ee', groutColor: '#c4bfb6' },
  { id: 'fd-porcelain-24x24-white', brand: 'Floor & Decor', collection: 'Coastal', name: 'White Porcelain 24x24', widthIn: 24, heightIn: 24, priceUsd: 3.29, priceUnit: 'sqft', format: 'field', color: '#eceef0', groutColor: '#b0b6bf' },
  { id: 'fd-porcelain-12x24-charcoal', brand: 'Floor & Decor', collection: 'Coastal', name: 'Charcoal Porcelain 12x24', widthIn: 12, heightIn: 24, priceUsd: 3.49, priceUnit: 'sqft', format: 'field', color: '#4b525c', groutColor: '#2c313a' },
  { id: 'fd-wood-plank-6x24', brand: 'Floor & Decor', collection: 'Timbershaw', name: 'Oak Wood-Look 6x24', widthIn: 6, heightIn: 24, priceUsd: 2.29, priceUnit: 'sqft', format: 'plank', color: '#d8bb93', groutColor: '#a98d67' },
  { id: 'fd-wood-plank-8x48', brand: 'Floor & Decor', collection: 'Timbershaw', name: 'Walnut Wood-Look 8x48', widthIn: 8, heightIn: 48, priceUsd: 2.79, priceUnit: 'sqft', format: 'plank', color: '#a5794f', groutColor: '#75512f' },
  { id: 'fd-hex-white-2', brand: 'Floor & Decor', collection: 'Enchanted', name: 'White Hex 2 in', widthIn: 2, heightIn: 2, priceUsd: 8.99, priceUnit: 'piece', format: 'hex', color: '#f2f3f5', groutColor: '#9aa1ab' },
  { id: 'fd-penny-white', brand: 'Floor & Decor', collection: 'Enchanted', name: 'White Penny Round', widthIn: 12, heightIn: 12, priceUsd: 9.49, priceUnit: 'piece', format: 'penny', color: '#f4f5f6', groutColor: '#9aa1ab' },
  { id: 'fd-mosaic-2x2-blue', brand: 'Floor & Decor', collection: 'Lagoon', name: 'Blue Glass Mosaic 2x2', widthIn: 12, heightIn: 12, priceUsd: 11.99, priceUnit: 'piece', format: 'mosaic', color: '#5b93b8', groutColor: '#2f5066' },
  { id: 'fd-herringbone-2x8-white', brand: 'Floor & Decor', collection: 'Weave', name: 'White Herringbone 2x8', widthIn: 2, heightIn: 8, priceUsd: 1.19, priceUnit: 'piece', format: 'herringbone', color: '#eef0f2', groutColor: '#b7bcc4' },
  { id: 'fd-slate-12x12', brand: 'Floor & Decor', collection: 'Montane', name: 'Slate Look 12x12', widthIn: 12, heightIn: 12, priceUsd: 2.49, priceUnit: 'sqft', format: 'field', color: '#585d63', groutColor: '#34383d' },
  { id: 'fd-travertine-18x18', brand: 'Floor & Decor', collection: 'Montane', name: 'Travertine 18x18', widthIn: 18, heightIn: 18, priceUsd: 3.79, priceUnit: 'sqft', format: 'field', color: '#ddd0ba', groutColor: '#b09b7d' },
  { id: 'fd-cement-8x8', brand: 'Floor & Decor', collection: 'Casablanca', name: 'Patterned Cement 8x8', widthIn: 8, heightIn: 8, priceUsd: 4.29, priceUnit: 'piece', format: 'field', color: '#c7cbd0', groutColor: '#7d838c' },
  { id: 'fd-glass-1x2', brand: 'Floor & Decor', collection: 'Lagoon', name: 'Green Glass Linear 1x2', widthIn: 12, heightIn: 12, priceUsd: 12.99, priceUnit: 'piece', format: 'mosaic', color: '#7fae86', groutColor: '#41654a' },
  { id: 'fd-picket-3x12', brand: 'Floor & Decor', collection: 'Weave', name: 'White Picket 3x12', widthIn: 3, heightIn: 12, priceUsd: 6.99, priceUnit: 'sqft', format: 'herringbone', color: '#f1f2f4', groutColor: '#b7bcc4' },

  // MSI
  { id: 'msi-subway-white-3x6', brand: 'MSI', collection: 'Domino', name: 'White Glossy Subway', widthIn: 3, heightIn: 6, priceUsd: 0.33, priceUnit: 'piece', format: 'subway', color: '#f6f7f8', groutColor: '#c9ced6' },
  { id: 'msi-subway-3x12-gloss', brand: 'MSI', collection: 'Domino', name: 'White Glossy 3x12', widthIn: 3, heightIn: 12, priceUsd: 0.72, priceUnit: 'piece', format: 'subway', color: '#f3f4f6', groutColor: '#c9ced6' },
  { id: 'msi-carrara-12x24', brand: 'MSI', collection: 'Eden', name: 'Carrara White 12x24', widthIn: 12, heightIn: 24, priceUsd: 4.79, priceUnit: 'sqft', format: 'field', color: '#eef0f2', groutColor: '#b7bcc4' },
  { id: 'msi-calacatta-24x48', brand: 'MSI', collection: 'Eden', name: 'Calacatta Gold 24x48', widthIn: 24, heightIn: 48, priceUsd: 6.29, priceUnit: 'sqft', format: 'field', color: '#f5f2ea', groutColor: '#c8bfa9' },
  { id: 'msi-porcelain-24x24-gray', brand: 'MSI', collection: 'Dimensions', name: 'Gray Porcelain 24x24', widthIn: 24, heightIn: 24, priceUsd: 3.19, priceUnit: 'sqft', format: 'field', color: '#c2c6cb', groutColor: '#7d838c' },
  { id: 'msi-porcelain-12x24-beige', brand: 'MSI', collection: 'Dimensions', name: 'Beige Porcelain 12x24', widthIn: 12, heightIn: 24, priceUsd: 3.09, priceUnit: 'sqft', format: 'field', color: '#e2d9c9', groutColor: '#b0a58e' },
  { id: 'msi-wood-plank-6x36', brand: 'MSI', collection: 'Havenwood', name: 'Beige Wood-Look 6x36', widthIn: 6, heightIn: 36, priceUsd: 2.39, priceUnit: 'sqft', format: 'plank', color: '#d5bd9c', groutColor: '#a6875f' },
  { id: 'msi-wood-plank-8x40', brand: 'MSI', collection: 'Havenwood', name: 'Saddle Wood-Look 8x40', widthIn: 8, heightIn: 40, priceUsd: 2.89, priceUnit: 'sqft', format: 'plank', color: '#9c7047', groutColor: '#6d4c2c' },
  { id: 'msi-hex-2-marble', brand: 'MSI', collection: 'Adella', name: 'Marble Hex 2 in', widthIn: 2, heightIn: 2, priceUsd: 9.29, priceUnit: 'piece', format: 'hex', color: '#eceef0', groutColor: '#9aa1ab' },
  { id: 'msi-penny-round', brand: 'MSI', collection: 'Adella', name: 'Gray Penny Round', widthIn: 12, heightIn: 12, priceUsd: 9.99, priceUnit: 'piece', format: 'penny', color: '#c2c6cb', groutColor: '#6b7280' },
  { id: 'msi-mosaic-2x2', brand: 'MSI', collection: 'Kenzzi', name: 'White Marble Mosaic 2x2', widthIn: 12, heightIn: 12, priceUsd: 10.99, priceUnit: 'piece', format: 'mosaic', color: '#eef0f2', groutColor: '#9aa1ab' },
  { id: 'msi-herringbone-3x12', brand: 'MSI', collection: 'Kenzzi', name: 'Gray Herringbone 3x12', widthIn: 3, heightIn: 12, priceUsd: 1.29, priceUnit: 'piece', format: 'herringbone', color: '#b6bcc4', groutColor: '#6b7280' },
  { id: 'msi-marble-12x12', brand: 'MSI', collection: 'Greecian', name: 'Greecian White 12x12', widthIn: 12, heightIn: 12, priceUsd: 5.49, priceUnit: 'sqft', format: 'field', color: '#f0f1f3', groutColor: '#b7bcc4' },
  { id: 'msi-quartzite-24x24', brand: 'MSI', collection: 'Dimensions', name: 'White Quartzite 24x24', widthIn: 24, heightIn: 24, priceUsd: 4.09, priceUnit: 'sqft', format: 'field', color: '#e6e8ea', groutColor: '#a9afb8' },
  { id: 'msi-glass-mosaic', brand: 'MSI', collection: 'Kenzzi', name: 'Aqua Glass Mosaic', widthIn: 12, heightIn: 12, priceUsd: 12.49, priceUnit: 'piece', format: 'mosaic', color: '#6fa9c0', groutColor: '#3a6274' },
  { id: 'msi-picket-3x12', brand: 'MSI', collection: 'Domino', name: 'White Picket 3x12', widthIn: 3, heightIn: 12, priceUsd: 7.29, priceUnit: 'sqft', format: 'herringbone', color: '#f1f2f4', groutColor: '#b7bcc4' },

  // other (небрендированные ходовые форматы)
  { id: 'other-subway-white-3x6', brand: 'other', collection: 'Generic', name: 'White Subway 3x6', widthIn: 3, heightIn: 6, priceUsd: 0.29, priceUnit: 'piece', format: 'subway', color: '#f4f5f6', groutColor: '#c9ced6' },
  { id: 'other-mosaic-1x1', brand: 'other', collection: 'Generic', name: 'White Mosaic 1x1', widthIn: 12, heightIn: 12, priceUsd: 8.49, priceUnit: 'piece', format: 'mosaic', color: '#eef0f2', groutColor: '#9aa1ab' },
  { id: 'other-large-24x48', brand: 'other', collection: 'Generic', name: 'Gray Large Format 24x48', widthIn: 24, heightIn: 48, priceUsd: 3.99, priceUnit: 'sqft', format: 'field', color: '#cbcfd4', groutColor: '#828992' },
]

export const TILE_CATALOG_ENTRIES: readonly TileCatalogEntry[] = TILE_CATALOG_SEED.map((seed) => ({
  ...seed,
  photoUrl: tilePhotoDataUri(seed.color, seed.groutColor, seed.format),
}))

const TILE_CATALOG_BY_ID = new Map(TILE_CATALOG_ENTRIES.map((entry) => [entry.id, entry]))

export function tileCatalogEntryById(id: string | undefined | null): TileCatalogEntry | undefined {
  if (!id) return undefined
  return TILE_CATALOG_BY_ID.get(id)
}

export function tileCatalogByBrand(brand: TileBrand): TileCatalogEntry[] {
  return TILE_CATALOG_ENTRIES.filter((entry) => entry.brand === brand)
}

// --- Стоимость зоны: площадь × цена/sqft, либо кол-во плиток × цена/шт ---

export function tileEntryAreaSqft(basis: Pick<TileCostBasis, 'widthIn' | 'heightIn'>): number {
  return (Math.max(0, basis.widthIn) * Math.max(0, basis.heightIn)) / 144
}

// Кол-во плиток, чтобы покрыть площадь зоны (предварительно, без запаса на подрезку).
export function tileZoneTileCount(basis: Pick<TileCostBasis, 'widthIn' | 'heightIn'>, areaSqft: number): number {
  const per = tileEntryAreaSqft(basis)
  if (!(per > 0) || !(areaSqft > 0)) return 0
  return Math.ceil(areaSqft / per)
}

// Предварительная стоимость зоны в USD. Для sqft — площадь × цена; для шт — кол-во плиток × цена.
export function tileZoneCostUsd(basis: TileCostBasis, areaSqft: number): number {
  if (!(basis.priceUsd > 0) || !(areaSqft > 0)) return 0
  if (basis.priceUnit === 'piece') return tileZoneTileCount(basis, areaSqft) * basis.priceUsd
  return areaSqft * basis.priceUsd
}

// --- Форматирование для карточек/панели ---

function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '')
}

export function tileSizeLabel(basis: Pick<TileCostBasis, 'widthIn' | 'heightIn'>): string {
  return `${trimNumber(basis.widthIn)} × ${trimNumber(basis.heightIn)} in`
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`
}

export function tilePriceLabel(basis: Pick<TileCostBasis, 'priceUsd' | 'priceUnit'>): string {
  return basis.priceUnit === 'piece' ? `${formatUsd(basis.priceUsd)}/pc` : `${formatUsd(basis.priceUsd)}/sq ft`
}
