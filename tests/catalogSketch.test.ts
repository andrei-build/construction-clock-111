import { describe, expect, it } from 'vitest'
import type { CatalogItem } from '../src/lib/api'
import {
  catalogDimsFromItem,
  catalogTileFinishPatch,
  resolvePlacedCatalogItem,
  snapshotCatalogItem,
  type SketchPlacedCatalogItem,
} from '../src/screens/project-hub/sketchCatalog'
import { normalizeFinishes } from '../src/screens/project-hub/sketchFinishes'
import { estimateTileLayout } from '../src/screens/project-hub/tileLayout'
import { buildPhotoRenderFacts } from '../src/screens/project-hub/Sketch3DView'

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
