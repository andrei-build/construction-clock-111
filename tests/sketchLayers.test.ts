import { describe, it, expect } from 'vitest'
import {
  SKETCH_LAYERS,
  DEFAULT_SKETCH_LAYER,
  sanitizeLayer,
  resolveLayer,
  isLayerVisible,
  layerFill,
  layerIsDashed,
  layerFillPatternId,
  LAYER_HATCH_PATTERN_ID,
  LAYER_DEMO_PATTERN_ID,
  LAYER_LABEL_KEYS,
} from '../src/lib/sketchLayers'

describe('sanitizeLayer', () => {
  it('accepts the three known layer values verbatim', () => {
    expect(sanitizeLayer('existing')).toBe('existing')
    expect(sanitizeLayer('new')).toBe('new')
    expect(sanitizeLayer('demolition')).toBe('demolition')
  })

  it('drops unknown / broken values to undefined (field omitted at save)', () => {
    expect(sanitizeLayer(undefined)).toBeUndefined()
    expect(sanitizeLayer(null)).toBeUndefined()
    expect(sanitizeLayer('')).toBeUndefined()
    expect(sanitizeLayer('NEW')).toBeUndefined()
    expect(sanitizeLayer('demo')).toBeUndefined()
    expect(sanitizeLayer(0)).toBeUndefined()
    expect(sanitizeLayer(1)).toBeUndefined()
    expect(sanitizeLayer({})).toBeUndefined()
    expect(sanitizeLayer(['existing'])).toBeUndefined()
  })

  it('default layer is "new" and lives in the known list', () => {
    expect(DEFAULT_SKETCH_LAYER).toBe('new')
    expect(SKETCH_LAYERS).toEqual(['existing', 'new', 'demolition'])
    expect(SKETCH_LAYERS).toContain(DEFAULT_SKETCH_LAYER)
  })
})

describe('resolveLayer', () => {
  it('passes valid values through', () => {
    expect(resolveLayer('existing')).toBe('existing')
    expect(resolveLayer('demolition')).toBe('demolition')
  })

  it('falls back to the default for missing / invalid values (version:1 old sketch)', () => {
    expect(resolveLayer(undefined)).toBe('new')
    expect(resolveLayer(null)).toBe('new')
    expect(resolveLayer('junk')).toBe('new')
  })
})

describe('isLayerVisible', () => {
  it('shows everything when the hide-existing toggle is off', () => {
    expect(isLayerVisible('existing', false)).toBe(true)
    expect(isLayerVisible('new', false)).toBe(true)
    expect(isLayerVisible('demolition', false)).toBe(true)
    expect(isLayerVisible(undefined, false)).toBe(true)
  })

  it('hides only the existing layer when the toggle is on', () => {
    expect(isLayerVisible('existing', true)).toBe(false)
    expect(isLayerVisible('new', true)).toBe(true)
    expect(isLayerVisible('demolition', true)).toBe(true)
    // Old sketch without layer defaults to 'new' → stays visible.
    expect(isLayerVisible(undefined, true)).toBe(true)
    expect(isLayerVisible('junk', true)).toBe(true)
  })
})

describe('layerFill / layerIsDashed (pattern selection by layer)', () => {
  it('existing → diagonal hatch, no dash', () => {
    expect(layerFill('existing')).toBe('hatch')
    expect(layerIsDashed('existing')).toBe(false)
  })

  it('new → plain clean fill, no dash', () => {
    expect(layerFill('new')).toBe('plain')
    expect(layerFill(undefined)).toBe('plain')
    expect(layerIsDashed('new')).toBe(false)
  })

  it('demolition → demolition fill + dashed contour', () => {
    expect(layerFill('demolition')).toBe('demolition')
    expect(layerIsDashed('demolition')).toBe(true)
  })
})

describe('layerFillPatternId', () => {
  it('maps each layer to its SVG pattern reference (or null for plain new)', () => {
    expect(layerFillPatternId('existing')).toBe(LAYER_HATCH_PATTERN_ID)
    expect(layerFillPatternId('demolition')).toBe(LAYER_DEMO_PATTERN_ID)
    expect(layerFillPatternId('new')).toBeNull()
    expect(layerFillPatternId(undefined)).toBeNull()
  })
})

describe('LAYER_LABEL_KEYS', () => {
  it('has an i18n key for every known layer', () => {
    for (const layer of SKETCH_LAYERS) {
      expect(typeof LAYER_LABEL_KEYS[layer]).toBe('string')
      expect(LAYER_LABEL_KEYS[layer].length).toBeGreaterThan(0)
    }
  })
})
