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
