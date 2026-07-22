import { describe, expect, it } from 'vitest'
import {
  TILE_CATALOG_BRANDS,
  TILE_CATALOG_ENTRIES,
  tileCatalogByBrand,
  tileCatalogEntryById,
  tileEntryAreaSqft,
  tilePriceLabel,
  tileSizeLabel,
  tileZoneCostUsd,
  tileZoneTileCount,
  formatUsd,
} from '../src/screens/project-hub/tileCatalog'
import { normalizeTileSurface, sanitizeSketchFinishes } from '../src/screens/project-hub/sketchFinishes'

// TILE-CATALOG-29: реальный каталог плитки (бренд/коллекция/размер/цена/фото-плейсхолдер) в отделке.
// Проверяем валидность сида, стоимость зоны (площадь×цена / кол-во×цена) и round-trip выбора через
// sanitize (version:1 allowlist: новые поля выживают, старый эскиз без них грузится).

describe('tile catalog seed', () => {
  it('has 30+ positions across both real brands', () => {
    expect(TILE_CATALOG_ENTRIES.length).toBeGreaterThanOrEqual(30)
    expect(tileCatalogByBrand('Floor & Decor').length).toBeGreaterThan(0)
    expect(tileCatalogByBrand('MSI').length).toBeGreaterThan(0)
  })

  it('every entry has a valid brand, positive size, positive price and a placeholder photo', () => {
    for (const entry of TILE_CATALOG_ENTRIES) {
      expect(TILE_CATALOG_BRANDS).toContain(entry.brand)
      expect(entry.widthIn).toBeGreaterThan(0)
      expect(entry.heightIn).toBeGreaterThan(0)
      expect(entry.priceUsd).toBeGreaterThan(0)
      expect(['sqft', 'piece']).toContain(entry.priceUnit)
      expect(entry.collection.trim().length).toBeGreaterThan(0)
      expect(entry.name.trim().length).toBeGreaterThan(0)
      // фото — инлайн-плейсхолдер (data-URI), НЕ внешний ассет, и достаточно короткий чтобы сохраняться
      expect(entry.photoUrl.startsWith('data:image/svg+xml')).toBe(true)
      expect(entry.photoUrl.length).toBeLessThan(4000)
      expect(/^#[0-9a-f]{6}$/i.test(entry.color)).toBe(true)
      expect(/^#[0-9a-f]{6}$/i.test(entry.groutColor)).toBe(true)
    }
  })

  it('has unique ids and covers common formats (subway/mosaic/large field)', () => {
    const ids = new Set(TILE_CATALOG_ENTRIES.map((entry) => entry.id))
    expect(ids.size).toBe(TILE_CATALOG_ENTRIES.length)
    const formats = new Set(TILE_CATALOG_ENTRIES.map((entry) => entry.format))
    expect(formats.has('subway')).toBe(true)
    expect(formats.has('mosaic')).toBe(true)
    expect(formats.has('field')).toBe(true)
    // ходовые размеры: subway 3x6 и field 12x24 и 24x24 присутствуют
    expect(TILE_CATALOG_ENTRIES.some((e) => e.widthIn === 3 && e.heightIn === 6)).toBe(true)
    expect(TILE_CATALOG_ENTRIES.some((e) => e.widthIn === 12 && e.heightIn === 24)).toBe(true)
    expect(TILE_CATALOG_ENTRIES.some((e) => e.widthIn === 24 && e.heightIn === 24)).toBe(true)
  })

  it('looks up by id', () => {
    const first = TILE_CATALOG_ENTRIES[0]
    expect(tileCatalogEntryById(first.id)?.id).toBe(first.id)
    expect(tileCatalogEntryById('nope')).toBeUndefined()
    expect(tileCatalogEntryById(undefined)).toBeUndefined()
  })
})

describe('tile zone cost', () => {
  it('per-sqft cost = area × price for a 12x24 field tile', () => {
    const basis = { priceUsd: 4.99, priceUnit: 'sqft' as const, widthIn: 12, heightIn: 24 }
    expect(tileZoneCostUsd(basis, 120)).toBeCloseTo(120 * 4.99, 6)
    expect(tileZoneCostUsd(basis, 0)).toBe(0)
  })

  it('12x24 tile covers 2 sq ft each; per-piece cost = ceil(area / tileArea) × price', () => {
    const basis = { priceUsd: 3, priceUnit: 'piece' as const, widthIn: 12, heightIn: 24 }
    expect(tileEntryAreaSqft(basis)).toBeCloseTo(2, 6)
    // 21 sqft / 2 sqft = 10.5 → 11 плиток
    expect(tileZoneTileCount(basis, 21)).toBe(11)
    expect(tileZoneCostUsd(basis, 21)).toBe(11 * 3)
  })

  it('zero price or zero area yields zero cost', () => {
    expect(tileZoneCostUsd({ priceUsd: 0, priceUnit: 'sqft', widthIn: 12, heightIn: 24 }, 100)).toBe(0)
    expect(tileZoneTileCount({ widthIn: 0, heightIn: 0 }, 100)).toBe(0)
  })

  it('formats price and size labels', () => {
    expect(formatUsd(4.99)).toBe('$4.99')
    expect(tilePriceLabel({ priceUsd: 4.99, priceUnit: 'sqft' })).toBe('$4.99/sq ft')
    expect(tilePriceLabel({ priceUsd: 0.35, priceUnit: 'piece' })).toBe('$0.35/pc')
    expect(tileSizeLabel({ widthIn: 12, heightIn: 24 })).toBe('12 × 24 in')
  })
})

describe('tile catalog selection round-trip (version:1 allowlist)', () => {
  it('keeps catalog fields through normalizeTileSurface', () => {
    const entry = TILE_CATALOG_ENTRIES.find((e) => e.widthIn === 12 && e.heightIn === 24 && e.priceUnit === 'sqft')!
    const surface = normalizeTileSurface({
      kind: 'tile',
      tileWIn: entry.widthIn,
      tileHIn: entry.heightIn,
      tileColor: entry.color,
      groutColor: entry.groutColor,
      catalogItemId: entry.id,
      catalogItemName: `${entry.brand} · ${entry.name}`,
      catalogPhotoPath: entry.photoUrl,
      catalogBrand: entry.brand,
      catalogCollection: entry.collection,
      catalogPriceUsd: entry.priceUsd,
      catalogPriceUnit: entry.priceUnit,
    })
    expect(surface.tileWIn).toBe(12)
    expect(surface.tileHIn).toBe(24)
    expect(surface.catalogItemId).toBe(entry.id)
    expect(surface.catalogBrand).toBe(entry.brand)
    expect(surface.catalogCollection).toBe(entry.collection)
    expect(surface.catalogPriceUsd).toBe(entry.priceUsd)
    expect(surface.catalogPriceUnit).toBe('sqft')
    expect(surface.catalogPhotoPath).toBe(entry.photoUrl)
  })

  it('round-trips catalog tile through full finishes sanitize (save → reload)', () => {
    const entry = TILE_CATALOG_ENTRIES[0]
    const saved = sanitizeSketchFinishes({
      wallFinishes: {
        '0:0': {
          kind: 'tile',
          tileWIn: entry.widthIn,
          tileHIn: entry.heightIn,
          catalogItemId: entry.id,
          catalogBrand: entry.brand,
          catalogCollection: entry.collection,
          catalogPriceUsd: entry.priceUsd,
          catalogPriceUnit: entry.priceUnit,
        },
      },
    })
    const reloaded = sanitizeSketchFinishes(saved)
    const surface = reloaded?.wallFinishes?.['0:0']
    expect(surface?.kind).toBe('tile')
    if (surface?.kind !== 'tile') throw new Error('expected tile')
    expect(surface.catalogItemId).toBe(entry.id)
    expect(surface.catalogBrand).toBe(entry.brand)
    expect(surface.catalogPriceUsd).toBe(entry.priceUsd)
    expect(surface.catalogPriceUnit).toBe(entry.priceUnit)
  })

  it('drops an invalid price unit but keeps the tile', () => {
    const surface = normalizeTileSurface({
      kind: 'tile',
      tileWIn: 12,
      tileHIn: 24,
      catalogPriceUnit: 'each' as unknown as 'sqft',
    })
    expect(surface.kind).toBe('tile')
    expect(surface.catalogPriceUnit).toBeUndefined()
  })

  it('an old tile finish without catalog fields still loads', () => {
    const surface = normalizeTileSurface({ kind: 'tile', tileWIn: 12, tileHIn: 24 })
    expect(surface.tileWIn).toBe(12)
    expect(surface.catalogItemId).toBeUndefined()
    expect(surface.catalogBrand).toBeUndefined()
    expect(surface.catalogPriceUsd).toBeUndefined()
    expect(surface.catalogPriceUnit).toBeUndefined()
  })
})
