import { describe, expect, it } from 'vitest'
import {
  TILE_MATERIAL_SECTION,
  buildTileCalcRpcArgs,
  normalizeTileCalcResult,
  tileCalcItemsToProjectMaterialInputs,
} from '../src/screens/project-hub/tileCalc'

describe('tile material calculator helpers', () => {
  it('builds the calc_tile_materials RPC argument names exactly', () => {
    expect(buildTileCalcRpcArgs({
      areaSqft: 120,
      tileWIn: 12,
      tileHIn: 24,
      jointIn: 0.125,
      tileThicknessIn: 0.3125,
      pattern: 'offset',
      boxSqft: 15.5,
      pricePerBox: 45,
      catalogItemId: null,
      perimeterLnft: 42,
      includeSubstrate: true,
      includeWaterproofing: false,
    })).toEqual({
      p_area_sqft: 120,
      p_tile_w_in: 12,
      p_tile_h_in: 24,
      p_joint_in: 0.125,
      p_tile_thickness_in: 0.3125,
      p_pattern: 'offset',
      p_box_sqft: 15.5,
      p_price_per_box: 45,
      p_catalog_item_id: null,
      p_perimeter_lnft: 42,
      p_include_substrate: true,
      p_include_waterproofing: false,
    })
  })

  it('uses catalog price source instead of manual price when a catalog item is selected', () => {
    const args = buildTileCalcRpcArgs({
      areaSqft: 120,
      tileWIn: 12,
      tileHIn: 24,
      jointIn: 0.125,
      tileThicknessIn: 0.3125,
      pattern: 'straight',
      boxSqft: 15.5,
      pricePerBox: 45,
      catalogItemId: '7d4c7c52-0e5c-4b91-aeba-58d8a7f2c6b5',
      perimeterLnft: null,
      includeSubstrate: false,
      includeWaterproofing: false,
    })
    expect(args.p_catalog_item_id).toBe('7d4c7c52-0e5c-4b91-aeba-58d8a7f2c6b5')
    expect(args.p_price_per_box).toBeNull()
  })

  it('normalizes jsonb output and maps rows to project material inputs', () => {
    const result = normalizeTileCalcResult({
      input: { area_sqft: 120 },
      norms_source: 'org',
      items: [
        { key: 'tile', name: '12x24 porcelain tile', qty: '9', unit: 'box', detail: '15.5 sqft/box', price: '45', total: '405' },
        { key: 'blank', name: '', qty: 1 },
      ],
      totals: { known_total: '405', complete: false },
    })

    expect(result.norms_source).toBe('org')
    expect(result.items).toHaveLength(1)
    expect(result.items[0].qty).toBe(9)
    expect(result.items[0].total).toBe(405)
    expect(result.totals).toEqual({ known_total: 405, complete: false })

    expect(tileCalcItemsToProjectMaterialInputs(result.items)).toEqual([
      {
        section: TILE_MATERIAL_SECTION,
        name: '12x24 porcelain tile',
        qty: 9,
        unit: 'box',
        note: '15.5 sqft/box',
      },
    ])
  })
})
