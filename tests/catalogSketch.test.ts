import { describe, expect, it } from 'vitest'
import type { CatalogItem } from '../src/lib/api'
import {
  BUILTIN_SHOWER_PAN_CATALOG_ITEMS,
  BUILTIN_SHOWER_PAN_NEO_CATALOG_ID,
  BUILTIN_SHOWER_PAN_RECT_CATALOG_ID,
  catalogDimsFromItem,
  catalogTileFinishPatch,
  createShowerPanPlacedCatalogItem,
  isShowerPanPlacedCatalogItem,
  resolvePlacedCatalogItem,
  sanitizePlacedCatalogItems,
  showerPanShapeFromPlacedItem,
  snapshotCatalogItem,
  type SketchPlacedCatalogItem,
} from '../src/screens/project-hub/sketchCatalog'
import { normalizeFinishes } from '../src/screens/project-hub/sketchFinishes'
import { estimateTileLayout } from '../src/screens/project-hub/tileLayout'
import { buildPhotoRenderFacts, stripImageDataUrlPrefix } from '../src/screens/project-hub/Sketch3DView'

function catalogItem(patch: Partial<CatalogItem>): CatalogItem {
  return {
    id: 'item-1',
    org_id: 'org-1',
    category: 'other',
    name: 'Item',
    brand: null,
    model: null,
    width_in: null,
    depth_in: null,
    height_in: null,
    photo_path: null,
    price: null,
    specs: null,
    url: null,
    note: null,
    is_active: true,
    sort_order: 0,
    created_by: null,
    created_at: '',
    updated_at: '',
    ...patch,
  }
}

describe('stripImageDataUrlPrefix', () => {
  it('removes a data URL prefix from base64 image payloads', () => {
    expect(stripImageDataUrlPrefix('data:image/jpeg;base64,abc123')).toBe('abc123')
  })

  it('leaves plain base64 unchanged', () => {
    expect(stripImageDataUrlPrefix('abc123')).toBe('abc123')
  })
})

const roomModel = {
  version: 1 as const,
  cellFt: 1,
  contours: [
    {
      closed: true,
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 8 },
        { x: 0, y: 8 },
      ],
    },
  ],
  openings: [],
}

describe('catalog-driven sketch data', () => {
  it('creates built-in shower pan placed items from catalog cards with real dimensions', () => {
    const rect = BUILTIN_SHOWER_PAN_CATALOG_ITEMS.find((item) => item.id === BUILTIN_SHOWER_PAN_RECT_CATALOG_ID)
    const neo = BUILTIN_SHOWER_PAN_CATALOG_ITEMS.find((item) => item.id === BUILTIN_SHOWER_PAN_NEO_CATALOG_ID)
    expect(rect).toBeDefined()
    expect(neo).toBeDefined()

    const placedRect = createShowerPanPlacedCatalogItem(rect!, 'placed-pan-rect', roomModel, 0.5)
    const placedNeo = createShowerPanPlacedCatalogItem(neo!, 'placed-pan-neo', roomModel, 0.5)

    expect(placedRect).toMatchObject({
      id: 'placed-pan-rect',
      catalogItemId: BUILTIN_SHOWER_PAN_RECT_CATALOG_ID,
      kind: 'SHOWER_PAN',
      category: 'shower',
      showerPanShape: 'rect',
      surface: 'floor',
      widthIn: 60,
      depthIn: 32,
      heightIn: 4,
      c: 0,
      s: 0,
    })
    expect(placedRect?.xFt).toBeCloseTo(2.5)
    expect(placedRect?.zFt).toBeCloseTo(32 / 24 + 0.25)
    expect(placedNeo).toMatchObject({
      catalogItemId: BUILTIN_SHOWER_PAN_NEO_CATALOG_ID,
      kind: 'SHOWER_PAN',
      showerPanShape: 'neo-angle',
      widthIn: 36,
      depthIn: 36,
      heightIn: 4,
    })
  })

  it('keeps old shower pan placed items without panFinish backward compatible', () => {
    const [placed] = sanitizePlacedCatalogItems([{
      id: 'old-pan',
      catalogItemId: BUILTIN_SHOWER_PAN_RECT_CATALOG_ID,
      xFt: 2,
      yFt: 2 / 12,
      zFt: 1,
      rotationY: 0,
      surface: 'floor',
      widthIn: 60,
      depthIn: 32,
      heightIn: 4,
    }])

    expect(isShowerPanPlacedCatalogItem(placed)).toBe(true)
    expect(showerPanShapeFromPlacedItem(placed)).toBe('rect')
    expect(placed.panFinish).toBeUndefined()
  })

  it('uses catalog tile width and height as tile layout inputs', () => {
    const tile = catalogItem({
      id: 'tile-3x12',
      category: 'tile',
      name: 'Gloss subway',
      width_in: 3,
      height_in: 12,
      photo_path: 'https://cdn.example/tile.jpg',
    })

    const patch = catalogTileFinishPatch(tile)
    expect(patch).toMatchObject({
      catalogItemId: 'tile-3x12',
      catalogItemName: 'Gloss subway',
      catalogPhotoPath: 'https://cdn.example/tile.jpg',
      tileWIn: 3,
      tileHIn: 12,
    })

    const layout = estimateTileLayout({
      surfaceWidthIn: 24,
      surfaceHeightIn: 24,
      tileWIn: patch?.tileWIn ?? 0,
      tileHIn: patch?.tileHIn ?? 0,
      groutIn: 0,
    })

    expect(layout.columns.count).toBe(8)
    expect(layout.rows.count).toBe(2)
  })

  it('resolves appliance mesh dimensions from specs when catalog dimension columns are empty', () => {
    const appliance = catalogItem({
      id: 'range-30',
      category: 'other',
      name: 'Range',
      specs: { 'Ш x В x Г': '30 x 36 x 24', power: '7.2 kW' },
    })

    expect(catalogDimsFromItem(appliance)).toEqual({
      widthFt: 2.5,
      depthFt: 2,
      heightFt: 3,
    })
  })

  it('includes selected catalog specs in render-photo facts', () => {
    const appliance = catalogItem({
      id: 'dishwasher-24',
      category: 'other',
      name: 'Dishwasher',
      specs: { model: 'DW-24', color: 'stainless', power: '120V' },
      width_in: 24,
      depth_in: 24,
      height_in: 34,
    })
    const placed: SketchPlacedCatalogItem = {
      id: 'placed-dw',
      ...snapshotCatalogItem(appliance),
      xFt: 3,
      yFt: 34 / 24,
      zFt: 2,
      rotationY: 0,
      surface: 'floor',
    }
    const resolved = resolvePlacedCatalogItem(placed, appliance)
    expect(resolved).not.toBeNull()

    const facts = buildPhotoRenderFacts(roomModel, 8, normalizeFinishes(), [resolved!], 'fit', 'kitchen', 'Project')
    expect(facts.items[0].specs).toMatchObject({ model: 'DW-24', color: 'stainless', power: '120V' })
    expect((facts.items[0].dimensions as { width: { value_in: number } }).width.value_in).toBe(24)
  })
})
