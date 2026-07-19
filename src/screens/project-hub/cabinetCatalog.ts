export type CabinetCatalogCategoryId =
  | 'base'
  | 'drawers'
  | 'sink'
  | 'corners'
  | 'wall'
  | 'tall'
  | 'vanity'
  | 'fillers'
  | 'appliances'

export type CabinetCatalogIcon =
  | 'base'
  | 'sink'
  | 'drawer1'
  | 'drawer2'
  | 'drawer3'
  | 'lazySusan'
  | 'blindCorner'
  | 'wall'
  | 'tallPantry'
  | 'ovenTower'
  | 'vanity'
  | 'filler'
  | 'baseEndPanel'
  | 'refrigeratorEndPanel'
  | 'dishwasher'
  | 'range'
  | 'refrigerator'
  | 'hood'
  | 'wine'

export type CabinetCatalogSizeKind = 'width' | 'wall' | 'panelDepth'

export type CabinetCatalogEntry = {
  id: string
  categoryId: CabinetCatalogCategoryId
  labelKey: string
  codePrefix: string
  icon: CabinetCatalogIcon
  sizeKind: CabinetCatalogSizeKind
  widthsIn: readonly number[]
  wallHeightsIn?: readonly number[]
}

export type CabinetCatalogCategory = {
  id: CabinetCatalogCategoryId
  labelKey: string
}

export const CABINET_CATALOG_STANDARD_WIDTHS_IN = [9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39, 42, 45, 48] as const
export const CABINET_CATALOG_WALL_HEIGHTS_IN = [12, 15, 18, 24, 30, 36, 42] as const

const FILLER_WIDTHS_IN = [3, 6, 9, 12, 15, 18, 21, 24] as const
const PANEL_DEPTHS_IN = [12, 21, 24, 30, 36] as const
const DISHWASHER_WIDTHS_IN = [18, 24] as const
const RANGE_WIDTHS_IN = [24, 30, 36, 48] as const
const REFRIGERATOR_WIDTHS_IN = [30, 33, 36, 42, 48] as const
const HOOD_WIDTHS_IN = [24, 30, 36, 42, 48] as const

export const CABINET_CATALOG_CATEGORIES: readonly CabinetCatalogCategory[] = [
  { id: 'base', labelKey: 'hub_sketch_cabinet_gallery_cat_base' },
  { id: 'drawers', labelKey: 'hub_sketch_cabinet_gallery_cat_drawers' },
  { id: 'sink', labelKey: 'hub_sketch_cabinet_gallery_cat_sink' },
  { id: 'corners', labelKey: 'hub_sketch_cabinet_gallery_cat_corners' },
  { id: 'wall', labelKey: 'hub_sketch_cabinet_gallery_cat_wall' },
  { id: 'tall', labelKey: 'hub_sketch_cabinet_gallery_cat_tall' },
  { id: 'vanity', labelKey: 'hub_sketch_cabinet_gallery_cat_vanity' },
  { id: 'fillers', labelKey: 'hub_sketch_cabinet_gallery_cat_fillers' },
  { id: 'appliances', labelKey: 'hub_sketch_cabinet_gallery_cat_appliances' },
] as const

export const CABINET_CATALOG_ENTRIES: readonly CabinetCatalogEntry[] = [
  {
    id: 'base-door',
    categoryId: 'base',
    labelKey: 'hub_sketch_cabinet_gallery_base',
    codePrefix: 'B',
    icon: 'base',
    sizeKind: 'width',
    widthsIn: CABINET_CATALOG_STANDARD_WIDTHS_IN,
  },
  {
    id: 'wine-rack',
    categoryId: 'base',
    labelKey: 'hub_sketch_cabinet_gallery_wine',
    codePrefix: 'WINE',
    icon: 'wine',
    sizeKind: 'width',
    widthsIn: CABINET_CATALOG_STANDARD_WIDTHS_IN,
  },
  {
    id: 'drawer-1',
    categoryId: 'drawers',
    labelKey: 'hub_sketch_cabinet_gallery_drawer_1',
    codePrefix: '1DB',
    icon: 'drawer1',
    sizeKind: 'width',
    widthsIn: CABINET_CATALOG_STANDARD_WIDTHS_IN,
  },
  {
    id: 'drawer-2',
    categoryId: 'drawers',
    labelKey: 'hub_sketch_cabinet_gallery_drawer_2',
    codePrefix: '2DB',
    icon: 'drawer2',
    sizeKind: 'width',
    widthsIn: CABINET_CATALOG_STANDARD_WIDTHS_IN,
  },
  {
    id: 'drawer-3',
    categoryId: 'drawers',
    labelKey: 'hub_sketch_cabinet_gallery_drawer_3',
    codePrefix: '3DB',
    icon: 'drawer3',
    sizeKind: 'width',
    widthsIn: CABINET_CATALOG_STANDARD_WIDTHS_IN,
  },
  {
    id: 'sink-base',
    categoryId: 'sink',
    labelKey: 'hub_sketch_cabinet_gallery_sink',
    codePrefix: 'SB',
    icon: 'sink',
    sizeKind: 'width',
    widthsIn: CABINET_CATALOG_STANDARD_WIDTHS_IN,
  },
  {
    id: 'lazy-susan',
    categoryId: 'corners',
    labelKey: 'hub_sketch_cabinet_gallery_lazy_susan',
    codePrefix: 'BLS',
    icon: 'lazySusan',
    sizeKind: 'width',
    widthsIn: CABINET_CATALOG_STANDARD_WIDTHS_IN,
  },
  {
    id: 'blind-corner',
    categoryId: 'corners',
    labelKey: 'hub_sketch_cabinet_gallery_blind_corner',
    codePrefix: 'BBC',
    icon: 'blindCorner',
    sizeKind: 'width',
    widthsIn: CABINET_CATALOG_STANDARD_WIDTHS_IN,
  },
  {
    id: 'wall-door',
    categoryId: 'wall',
    labelKey: 'hub_sketch_cabinet_gallery_wall',
    codePrefix: 'W',
    icon: 'wall',
    sizeKind: 'wall',
    widthsIn: CABINET_CATALOG_STANDARD_WIDTHS_IN,
    wallHeightsIn: CABINET_CATALOG_WALL_HEIGHTS_IN,
  },
  {
    id: 'tall-pantry',
    categoryId: 'tall',
    labelKey: 'hub_sketch_cabinet_gallery_tall_pantry',
    codePrefix: 'U',
    icon: 'tallPantry',
    sizeKind: 'width',
    widthsIn: CABINET_CATALOG_STANDARD_WIDTHS_IN,
  },
  {
    id: 'oven-tower',
    categoryId: 'tall',
    labelKey: 'hub_sketch_cabinet_gallery_oven_tower',
    codePrefix: 'U',
    icon: 'ovenTower',
    sizeKind: 'width',
    widthsIn: CABINET_CATALOG_STANDARD_WIDTHS_IN,
  },
  {
    id: 'vanity',
    categoryId: 'vanity',
    labelKey: 'hub_sketch_cabinet_gallery_vanity',
    codePrefix: 'V',
    icon: 'vanity',
    sizeKind: 'width',
    widthsIn: CABINET_CATALOG_STANDARD_WIDTHS_IN,
  },
  {
    id: 'base-filler',
    categoryId: 'fillers',
    labelKey: 'hub_sketch_cabinet_gallery_filler',
    codePrefix: 'BF',
    icon: 'filler',
    sizeKind: 'width',
    widthsIn: FILLER_WIDTHS_IN,
  },
  {
    id: 'base-end-panel',
    categoryId: 'fillers',
    labelKey: 'hub_sketch_cabinet_gallery_base_end_panel',
    codePrefix: 'BEP',
    icon: 'baseEndPanel',
    sizeKind: 'panelDepth',
    widthsIn: PANEL_DEPTHS_IN,
  },
  {
    id: 'refrigerator-end-panel',
    categoryId: 'fillers',
    labelKey: 'hub_sketch_cabinet_gallery_refrigerator_end_panel',
    codePrefix: 'REP',
    icon: 'refrigeratorEndPanel',
    sizeKind: 'panelDepth',
    widthsIn: PANEL_DEPTHS_IN,
  },
  {
    id: 'dishwasher',
    categoryId: 'appliances',
    labelKey: 'hub_sketch_cabinet_gallery_dishwasher',
    codePrefix: 'DW',
    icon: 'dishwasher',
    sizeKind: 'width',
    widthsIn: DISHWASHER_WIDTHS_IN,
  },
  {
    id: 'range',
    categoryId: 'appliances',
    labelKey: 'hub_sketch_cabinet_gallery_range',
    codePrefix: 'RANGE',
    icon: 'range',
    sizeKind: 'width',
    widthsIn: RANGE_WIDTHS_IN,
  },
  {
    id: 'refrigerator',
    categoryId: 'appliances',
    labelKey: 'hub_sketch_cabinet_gallery_refrigerator',
    codePrefix: 'REF',
    icon: 'refrigerator',
    sizeKind: 'width',
    widthsIn: REFRIGERATOR_WIDTHS_IN,
  },
  {
    id: 'hood',
    categoryId: 'appliances',
    labelKey: 'hub_sketch_cabinet_gallery_hood',
    codePrefix: 'HOOD',
    icon: 'hood',
    sizeKind: 'width',
    widthsIn: HOOD_WIDTHS_IN,
  },
] as const

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export function cabinetCatalogDefaultWidth(entry: Pick<CabinetCatalogEntry, 'widthsIn'>): number {
  return entry.widthsIn.includes(30) ? 30 : entry.widthsIn[0]
}

export function cabinetCatalogDefaultWallHeight(entry: Pick<CabinetCatalogEntry, 'wallHeightsIn'>): number {
  return entry.wallHeightsIn?.includes(30) ? 30 : entry.wallHeightsIn?.[0] ?? 30
}

export function cabinetCatalogEntryCode(entry: Pick<CabinetCatalogEntry, 'codePrefix' | 'sizeKind'>, widthIn: number, wallHeightIn = 30): string {
  if (entry.sizeKind === 'wall') return `W${pad2(widthIn)}${pad2(wallHeightIn)}`
  return `${entry.codePrefix}${widthIn}`
}
