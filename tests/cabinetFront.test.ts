import { describe, expect, it } from 'vitest'
import { computeCabinetFrontLayout } from '../src/screens/project-hub/cabinetFront'

// CABINET-FRONTS-25: чистая, детерминированная раскладка фронта (KCMA). Один источник правды
// для развёртки WallElevation и галереи. Модель/геометрия не трогаются — только отрисовка.

describe('computeCabinetFrontLayout — KCMA door/drawer layout', () => {
  it('B30 base = 2 doors + 1 top drawer, with toe-kick, no glass', () => {
    const layout = computeCabinetFrontLayout('B30', 30, 34.5)
    expect(layout.kind).toBe('base')
    expect(layout.doors).toBe(2)
    expect(layout.drawers).toBe(1)
    expect(layout.toeKick).toBe(true)
    expect(layout.toeKickFrac).toBeGreaterThan(0)
    expect(layout.glass).toBe(false)
    // верхний ящик + 2 двери = 3 фасада
    expect(layout.panels.filter((p) => p.type === 'drawer')).toHaveLength(1)
    expect(layout.panels.filter((p) => p.type === 'door')).toHaveLength(2)
  })

  it('narrow base (≤21") = 1 door + 1 drawer', () => {
    const layout = computeCabinetFrontLayout('B18', 18, 34.5)
    expect(layout.kind).toBe('base')
    expect(layout.doors).toBe(1)
    expect(layout.drawers).toBe(1)
  })

  it('base door count switches to 2 above 21"', () => {
    expect(computeCabinetFrontLayout('B21', 21, 34.5).doors).toBe(1)
    expect(computeCabinetFrontLayout('B24', 24, 34.5).doors).toBe(2)
  })

  it('wall cabinet W3030 has doors, NO drawers and NO toe-kick', () => {
    const layout = computeCabinetFrontLayout('W3030', 30, 30)
    expect(layout.kind).toBe('wall')
    expect(layout.toeKick).toBe(false)
    expect(layout.toeKickFrac).toBe(0)
    expect(layout.drawers).toBe(0)
    expect(layout.doors).toBe(2)
  })

  it('narrow wall (≤24") = 1 door, wide wall = 2 doors', () => {
    expect(computeCabinetFrontLayout('W2430', 24, 30).doors).toBe(1)
    expect(computeCabinetFrontLayout('W3630', 36, 30).doors).toBe(2)
  })

  it('drawer base 3DB30 = stack of 3 drawers, no doors, with toe-kick', () => {
    const layout = computeCabinetFrontLayout('3DB30', 30, 34.5)
    expect(layout.kind).toBe('drawerBase')
    expect(layout.drawers).toBe(3)
    expect(layout.doors).toBe(0)
    expect(layout.toeKick).toBe(true)
    expect(layout.panels.every((p) => p.type === 'drawer')).toBe(true)
  })

  it('drawer bank count follows 1DB/2DB/3DB code', () => {
    expect(computeCabinetFrontLayout('1DB24', 24, 34.5).drawers).toBe(1)
    expect(computeCabinetFrontLayout('2DB24', 24, 34.5).drawers).toBe(2)
    expect(computeCabinetFrontLayout('3DB24', 24, 34.5).drawers).toBe(3)
  })

  it('glass suffix (GD) sets glass flag and glass panels on a wall cabinet', () => {
    const layout = computeCabinetFrontLayout('W3030GD', 30, 30)
    expect(layout.kind).toBe('wall')
    expect(layout.glass).toBe(true)
    expect(layout.panels.some((p) => p.type === 'glass')).toBe(true)
    // без суффикса — обычные двери, стекла нет
    expect(computeCabinetFrontLayout('W3030', 30, 30).glass).toBe(false)
  })

  it('tall pantry U2490 = doors + toe-kick, no drawers', () => {
    const layout = computeCabinetFrontLayout('U2490', 24, 90)
    expect(layout.kind).toBe('tall')
    expect(layout.toeKick).toBe(true)
    expect(layout.drawers).toBe(0)
    expect(layout.doors).toBeGreaterThanOrEqual(2)
  })

  it('filler BF3 is classified as a filler strip (no pulls)', () => {
    const layout = computeCabinetFrontLayout('BF3', 3, 34.5)
    expect(layout.kind).toBe('filler')
    expect(layout.doors).toBe(0)
    expect(layout.drawers).toBe(0)
    expect(layout.panels.every((p) => p.pull === 'none')).toBe(true)
  })

  it('end panel BEP24 is classified as a panel', () => {
    const layout = computeCabinetFrontLayout('BEP24', 24, 34.5)
    expect(layout.kind).toBe('panel')
  })

  it('appliances are classified by code', () => {
    expect(computeCabinetFrontLayout('DW24', 24, 34.5).appliance).toBe('dishwasher')
    expect(computeCabinetFrontLayout('RANGE30', 30, 34.5).appliance).toBe('range')
    expect(computeCabinetFrontLayout('REF36', 36, 72).appliance).toBe('refrigerator')
    expect(computeCabinetFrontLayout('HOOD30', 30, 18).appliance).toBe('hood')
    expect(computeCabinetFrontLayout('WINE30', 30, 34.5).appliance).toBe('wine')
  })

  it('style parameter defaults to the shaker stub and is echoed back', () => {
    expect(computeCabinetFrontLayout('B30', 30, 34.5).style).toBe('shaker')
    expect(computeCabinetFrontLayout('B30', 30, 34.5, 'shaker').style).toBe('shaker')
  })

  it('is pure/deterministic — same inputs give identical panels', () => {
    const a = computeCabinetFrontLayout('B36', 36, 34.5)
    const b = computeCabinetFrontLayout('B36', 36, 34.5)
    expect(a).toEqual(b)
  })

  it('falls back gracefully for an unparseable code', () => {
    const layout = computeCabinetFrontLayout('???', 24, 34.5)
    expect(layout.widthIn).toBe(24)
    expect(layout.panels.length).toBeGreaterThan(0)
  })

  it('all panel rects stay within the [0..1] front box', () => {
    for (const code of ['B30', 'W3630', '3DB24', 'U3690', 'BF6', 'BEP24']) {
      const layout = computeCabinetFrontLayout(code, layout_width(code), 34.5)
      for (const p of layout.panels) {
        expect(p.x).toBeGreaterThanOrEqual(0)
        expect(p.y).toBeGreaterThanOrEqual(0)
        expect(p.x + p.w).toBeLessThanOrEqual(1.0001)
        expect(p.y + p.h).toBeLessThanOrEqual(1.0001)
      }
    }
  })
})

function layout_width(code: string): number {
  const m = code.match(/(\d{2})/)
  return m ? Number(m[1]) : 24
}
