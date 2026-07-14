// Строим ссылку «Маршрут / Directions» в приложение карт телефона — паритет с Check Time.
// Зависимостей нет. Приоритет — координаты (если обе конечны), иначе plain-text адрес.
// ВНИМАНИЕ: projects.site_point — это geography (HEX EWKB), НЕ парсится на клиенте.
// Сюда передаём только уже готовый адрес и/или числовые lat/lng, если они есть в объекте.

export interface DirectionsInput {
  address?: string | null
  lat?: number | string | null
  lng?: number | string | null
}

// Приводим к конечному числу (поля проекта бывают number | string | null).
function finiteNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : null
}

function isIosUserAgent(): boolean {
  if (typeof navigator === 'undefined') return false
  return /iPhone|iPad|iPod/i.test(navigator.userAgent)
}

// Возвращает URL для навигации в место проекта, либо '' если пункта назначения нет.
export function buildDirectionsUrl(input: DirectionsInput): string {
  const lat = finiteNumber(input.lat)
  const lng = finiteNumber(input.lng)
  const address = input.address?.trim()

  let destination: string
  if (lat !== null && lng !== null) {
    destination = `${lat},${lng}`
  } else if (address) {
    destination = address
  } else {
    return ''
  }

  const encoded = encodeURIComponent(destination)
  if (isIosUserAgent()) {
    return `https://maps.apple.com/?daddr=${encoded}`
  }
  return `https://www.google.com/maps/dir/?api=1&destination=${encoded}`
}

// ── PROJ-1b STEP 2: полный набор навигации карточки /projects (паритет Check Time) ────────────
// Точка назначения — координаты объекта (приоритет), иначе адрес; из неё строятся ссылки
// Google/Apple/geo и текст для «Скопировать точку» / Tesla-share. Чистые функции, без эффектов.

export interface NavDestination {
  query: string
  displayText: string
  source: 'coordinates' | 'address'
}

export function getNavigationDestination(input: DirectionsInput): NavDestination | null {
  const lat = finiteNumber(input.lat)
  const lng = finiteNumber(input.lng)
  if (lat !== null && lng !== null) {
    const query = `${lat},${lng}`
    return { query, displayText: query, source: 'coordinates' }
  }
  const address = input.address?.trim()
  if (!address) return null
  return { query: address, displayText: address, source: 'address' }
}

export function normalizeAddressForCopy(address: string | null | undefined): string | null {
  const normalized = address?.replace(/\s+/g, ' ').trim()
  return normalized ? normalized : null
}

export function buildAddressCopyText(input: { address?: string | null; destination: NavDestination }): string {
  return normalizeAddressForCopy(input.address) ?? input.destination.displayText
}

export function buildGoogleMapsUrl(dest: NavDestination): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest.query)}`
}

export function buildAppleMapsUrl(dest: NavDestination): string {
  return `https://maps.apple.com/?daddr=${encodeURIComponent(dest.query)}`
}

// «В путь»: нативная навигация устройства. iOS → Apple Maps; иначе geo:-URI (для координат
// сохраняем подпись проекта, адрес идёт как поисковый запрос).
export function buildGeoNavigationUrl(
  dest: NavDestination,
  options: { projectName?: string | null; userAgent?: string | null } = {},
): string {
  const userAgent = options.userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent)
  const isIos =
    /\b(iPad|iPhone|iPod)\b/i.test(userAgent) ||
    (/\bMacintosh\b/i.test(userAgent) && /\bMobile\b/i.test(userAgent))
  if (isIos) return `https://maps.apple.com/?q=${encodeURIComponent(dest.query)}`
  if (dest.source === 'coordinates') {
    const projectName = options.projectName?.trim()
    const geoQuery = projectName ? `${dest.query}(${projectName})` : dest.query
    return `geo:${dest.query}?q=${encodeURIComponent(geoQuery)}`
  }
  return `geo:0,0?q=${encodeURIComponent(dest.query)}`
}

export function buildNavigationShareText(input: {
  projectName: string
  destination: NavDestination
  address?: string | null
}): string {
  const lines = [input.projectName, input.destination.displayText]
  const address = normalizeAddressForCopy(input.address)
  if (address && address !== input.destination.displayText) lines.push(address)
  return lines.join('\n')
}

// «Скопировать точку» — ровно "lat,lng" (для полей навигации, Tesla и т.п.); null, если координат нет.
export function buildCoordinateCopyText(input: { lat?: number | string | null; lng?: number | string | null }): string | null {
  const lat = finiteNumber(input.lat)
  const lng = finiteNumber(input.lng)
  if (lat === null || lng === null) return null
  return `${lat},${lng}`
}
